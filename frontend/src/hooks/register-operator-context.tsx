'use client';

import { createContext, useContext } from 'react';

/** The staff member signed in at the till by PIN, and how to switch to another. */
export interface RegisterOperatorInfo {
  name: string;
  switchStaff: () => void;
}

const RegisterOperatorContext = createContext<RegisterOperatorInfo | null>(null);

export const RegisterOperatorProvider = RegisterOperatorContext.Provider;

/** null when no staff PIN session is active (PINs not set up, or not on /pos). */
export function useRegisterOperator(): RegisterOperatorInfo | null {
  return useContext(RegisterOperatorContext);
}
