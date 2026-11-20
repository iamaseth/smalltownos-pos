/** WebUSB ESC/POS thermal printer driver with browser print fallback. */

export type PrinterStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type PrintMode = 'escpos' | 'browser';

export interface PrinterInfo {
  vendorId: number;
  productId: number;
  manufacturerName?: string;
  productName?: string;
  serialNumber?: string;
}

type StatusListener = (status: PrinterStatus, info?: PrinterInfo) => void;

const ESCPOS_USB_CLASS = 0x07;
const PRINTER_INTERFACE = 0;
const PREFERRED_DEVICE_STORAGE_KEY = 'backstreet.usb.preferred-printer';

interface PreferredUsbDevice {
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

class PrinterService {
  private device: USBDevice | null = null;
  private interfaceClaimed = false;
  private claimedInterface: number | null = null;
  private endpointOut = 0x01; // discovered dynamically on connect()
  private _status: PrinterStatus = 'disconnected';
  private _printMode: PrintMode = 'escpos';
  private listeners: Set<StatusListener> = new Set();

  private readPreferredDevice(): PreferredUsbDevice | null {
    try {
      const stored = window.localStorage.getItem(PREFERRED_DEVICE_STORAGE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as Partial<PreferredUsbDevice>;
      if (typeof parsed.vendorId !== 'number' || typeof parsed.productId !== 'number') {
        return null;
      }
      return {
        vendorId: parsed.vendorId,
        productId: parsed.productId,
        serialNumber: typeof parsed.serialNumber === 'string' ? parsed.serialNumber : undefined,
      };
    } catch {
      return null;
    }
  }

  private rememberDevice(device: USBDevice): void {
    try {
      window.localStorage.setItem(PREFERRED_DEVICE_STORAGE_KEY, JSON.stringify({
        vendorId: device.vendorId,
        productId: device.productId,
        serialNumber: device.serialNumber ?? undefined,
      } satisfies PreferredUsbDevice));
    } catch {
      // Printing still works when browser storage is unavailable; only silent reconnect is disabled.
    }
  }

  private async closeCurrentDevice(): Promise<void> {
    navigator.usb?.removeEventListener('disconnect', this.handleDisconnect);

    if (this.device) {
      if (this.interfaceClaimed && this.claimedInterface !== null) {
        await this.device.releaseInterface(this.claimedInterface).catch(() => {});
      }
      await this.device.close().catch(() => {});
    }

    this.device = null;
    this.interfaceClaimed = false;
    this.claimedInterface = null;
    this.endpointOut = 0x01;
  }

  get isConnected(): boolean {
    return this._status === 'connected';
  }

  get status(): PrinterStatus {
    return this._status;
  }

  get printMode(): PrintMode {
    return this._printMode;
  }

  get deviceInfo(): PrinterInfo | null {
    if (!this.device) return null;
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      manufacturerName: this.device.manufacturerName ?? undefined,
      productName: this.device.productName ?? undefined,
      serialNumber: this.device.serialNumber ?? undefined,
    };
  }

  setPrintMode(mode: PrintMode): void {
    this._printMode = mode;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private static readonly DEVICE_FILTERS: USBDeviceFilter[] = [
    { classCode: ESCPOS_USB_CLASS },
    { vendorId: 0x0483 },
    { vendorId: 0x04b8 },
    { vendorId: 0x0519 },
    { vendorId: 0x0dd4 },
    { vendorId: 0x1504 },
    { vendorId: 0x1a86 },
    { vendorId: 0x1fc9 },
    { vendorId: 0x20d1 },
    { vendorId: 0x2109 },
    { vendorId: 0x22e0 },
    { vendorId: 0x2e8d },
    { vendorId: 0x37b9 },
    { vendorId: 0x41c9 },
    { vendorId: 0x4d42 },
    { vendorId: 0x5255 },
    { vendorId: 0x525a },
    { vendorId: 0x0fe6 },
    { vendorId: 0x1b24 },
    { vendorId: 0x0922 },
  ];

  /** Opens (or re-opens) a device and claims its ESC/POS interface. */
  private async openDevice(device: USBDevice): Promise<void> {
    // Always reopen and reclaim, even for the same device. A remembered USBDevice
    // object can survive after the physical printer or its interface has failed.
    await this.closeCurrentDevice();
    this.device = device;
    try {
      await this.device.open();

      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }

      for (const iface of this.device.configurations[0]?.interfaces ?? []) {
        const alt = iface.alternates[0];
        if (alt?.interfaceClass === ESCPOS_USB_CLASS) {
          await this.device.claimInterface(iface.interfaceNumber);
          this.interfaceClaimed = true;
          this.claimedInterface = iface.interfaceNumber;
          // Discover the bulk-OUT endpoint number from the descriptor
          const outEndpoint = alt.endpoints.find(
            (ep) => ep.type === 'bulk' && ep.direction === 'out'
          );
          if (outEndpoint) this.endpointOut = outEndpoint.endpointNumber;
          break;
        }
      }

      if (!this.interfaceClaimed) {
        await this.device.claimInterface(PRINTER_INTERFACE);
        this.interfaceClaimed = true;
        this.claimedInterface = PRINTER_INTERFACE;
      }
    } catch (err) {
      await this.closeCurrentDevice();
      this.setStatus('error');
      throw new Error(`Could not connect to printer: ${(err as Error).message}`);
    }

    this.setStatus('connected', this.deviceInfo ?? undefined);
    navigator.usb.addEventListener('disconnect', this.handleDisconnect);
  }

  // Serializes openDevice() to prevent concurrent mutations of device/interface state.
  private connectLock: Promise<unknown> = Promise.resolve();

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.connectLock.catch(() => undefined);
    const run = previous.then(fn, fn);
    this.connectLock = run.catch(() => undefined);
    return run;
  }

  /** Opens the browser's USB device picker and connects to a thermal printer. */
  async connect(): Promise<void> {
    if (this._printMode === 'browser') {
      return;
    }

    if (!navigator.usb) {
      throw new Error(
        'WebUSB API is not supported in this browser. Use Chrome or Edge 89+.'
      );
    }

    await this.runExclusive(async () => {
      this.setStatus('connecting');
      // An explicit connect means the operator wants to choose the physical printer.
      // Clear the prior session first so cancelling cannot leave a stale "connected" state.
      await this.closeCurrentDevice();

      let device: USBDevice;
      try {
        device = await navigator.usb!.requestDevice({ filters: PrinterService.DEVICE_FILTERS });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          this.setStatus('disconnected');
          return;
        }
        this.setStatus('error');
        throw new Error(`USB device selection failed: ${(err as Error).message}`);
      }

      await this.openDevice(device);
      this.rememberDevice(device);
    });
  }

  private reconnectPromise: Promise<boolean> | null = null;

  /** Silently re-attaches to a printer granted permission in a previous session. */
  async tryReconnect(): Promise<boolean> {
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this._printMode === 'browser' || this.device || !navigator.usb) {
      return false;
    }
    this.reconnectPromise = this.runExclusive(async () => {
      // Re-check after acquiring the lock: a concurrent connect() may have
      // already opened a device while this call was waiting its turn.
      if (this.device) return true;
      try {
        const preferred = this.readPreferredDevice();
        if (!preferred) return false;
        const devices = await navigator.usb!.getDevices();
        const matches = devices.filter((device) =>
          device.vendorId === preferred.vendorId
          && device.productId === preferred.productId
          && (!preferred.serialNumber || device.serialNumber === preferred.serialNumber)
        );
        // Without a serial number, reconnect only when the granted device is unambiguous.
        // This prevents silently selecting the wrong printer when two identical models exist.
        const previouslyGranted = matches.length === 1 ? matches[0] : undefined;
        if (!previouslyGranted) return false;
        this.setStatus('connecting');
        await this.openDevice(previouslyGranted);
        return true;
      } catch (err) {
        console.warn('[PrinterService] Silent reconnect failed:', err);
        this.setStatus('disconnected');
        return false;
      }
    }).finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  /** Waits for an in-flight silent reconnect to settle before caller checks connection. */
  async awaitPendingReconnect(): Promise<void> {
    if (this.reconnectPromise) await this.reconnectPromise;
  }

  async disconnect(): Promise<void> {
    await this.closeCurrentDevice();
    this.setStatus('disconnected');
  }

  /** Send raw ESC/POS bytes to the printer via WebUSB. */
  async print(data: Uint8Array): Promise<void> {
    if (this._printMode === 'browser') {
      throw new Error('Browser print mode is active. Use window.print() instead.');
    }

    if (!this.device || this._status !== 'connected') {
      throw new Error('Printer is not connected. Call connect() first.');
    }

    try {
      // Copy to fresh ArrayBuffer to avoid subarray view issues.
      const buf = new Uint8Array(data).buffer as ArrayBuffer;
      const result = await this.device.transferOut(this.endpointOut, buf);
      if (result.status !== 'ok') {
        throw new Error(`USB transfer returned ${result.status}`);
      }
    } catch (err) {
      await this.closeCurrentDevice();
      this.setStatus('error');
      throw new Error(`Print failed: ${(err as Error).message}`);
    }
  }

  /** Print using browser's print dialog with thermal-optimized styles. */
  async printViaBrowser(htmlContent: string, paperWidth: 58 | 80): Promise<void> {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      throw new Error('Please allow popups to print');
    }

    const mmWidth = paperWidth === 58 ? '58mm' : '80mm';

    // Establish a complete document before adding receipt content. Chrome can
    // otherwise finish loading the initial about:blank after our DOM changes
    // and replace them, leaving an empty print preview.
    printWindow.document.open();
    printWindow.document.write('<!doctype html><html><head><title>Receipt</title></head><body></body></html>');
    printWindow.document.close();

    const style = printWindow.document.createElement('style');
    style.textContent = `
      @page { size: ${mmWidth} auto; margin: 0; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Courier New', 'Noto Sans Devanagari', 'Nirmala UI', 'Kohinoor Devanagari', 'Devanagari Sangam MN', 'Noto Sans Thai', 'Leelawadee UI', Thonburi, monospace;
        font-size: 12px;
        line-height: 1.2;
        width: ${mmWidth};
        max-width: ${mmWidth};
        margin: 0 auto;
        padding: 4px;
        text-align: left;
      }
      @media print {
        body { width: ${mmWidth} !important; max-width: ${mmWidth} !important; }
        @page { size: ${mmWidth} auto; margin: 0; }
      }
    `;
    printWindow.document.head.appendChild(style);

    // Parse receipt markup and strip executable/script nodes before printing.
    const parsed = new DOMParser().parseFromString(htmlContent, 'text/html');
    parsed.querySelectorAll('script, link, meta, base, iframe, object, embed, form').forEach((node) => node.remove());
    parsed.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on')) {
          element.removeAttribute(attribute.name);
        } else if (
          ['href', 'src', 'action'].includes(name) &&
          /^(?:javascript|data):/i.test(attribute.value.trim())
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    });
    printWindow.document.body.replaceChildren(
      ...Array.from(parsed.body.childNodes).map((node) => printWindow.document.importNode(node, true)),
    );
    printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
    printWindow.focus();

    // Let Chrome paint the receipt before it captures the print preview.
    await new Promise<void>((resolve) => {
      printWindow.requestAnimationFrame(() => printWindow.requestAnimationFrame(() => resolve()));
    });
    printWindow.print();
  }

  private setStatus(status: PrinterStatus, info?: PrinterInfo): void {
    this._status = status;
    this.listeners.forEach((listener) => {
      try {
        listener(status, info);
      } catch (error) {
        console.warn('[PrinterService] Status listener failed:', error);
      }
    });
  }

  private handleDisconnect = (event: Event): void => {
    const e = event as USBConnectionEvent;
    if (e.device === this.device) {
      this.device = null;
      this.interfaceClaimed = false;
      this.claimedInterface = null;
      this.setStatus('disconnected');
    }
  };
}

export const printerService = new PrinterService();
