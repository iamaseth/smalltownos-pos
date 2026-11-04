#!/usr/bin/env node
// Run once with internet: node scripts/download-generic-menu-photos.cjs
// Photos are stored in frontend/public and thereafter work offline.
// Unsplash License: https://unsplash.com/license (review before distribution).
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, '../frontend/public/menu-generic');
fs.mkdirSync(out, {recursive:true});
const photos = {
  burger:'photo-1568901346375-23c9450c58cd',
  sandwich:'photo-1528735602780-2552fd46c7af',
  pizza:'photo-1513104890138-7c749659a591',
  fries:'photo-1573080496219-bb080dd4f877',
  rice:'photo-1603133872878-684f208fb84b',
  noodles:'photo-1569718212165-3a8278d5f624',
  salad:'photo-1512621776951-a57141f2eefd',
  soup:'photo-1547592180-85f173990554',
  breakfast:'photo-1533089860892-a7c6f0a88666',
  seafood:'photo-1559847844-5315695dadae',
  chicken:'photo-1532550907401-a500c9a57435',
  meat:'photo-1546833999-b9f581a1996d',
  'spring-rolls':'photo-1547592180-85f173990554',
  espresso:'photo-1511920170033-f8396924c348',
  latte:'photo-1461023058943-07fcbe16d735',
  'iced-coffee':'photo-1517701604599-bb29b565090c',
  coffee:'photo-1509042239860-f550ce710b93',
  smoothie:'photo-1505252585461-04db1eb84625',
  juice:'photo-1600271886742-f049cd451bba',
  tea:'photo-1544787219-7f47ccb76574',
  cocktail:'photo-1536935338788846bb9981813',
  whiskey:'photo-1527281400683-1aae777175f8',
  spirits:'photo-1513558161293-cdaf765edfd4',
  wine:'photo-1510812431401-41d2bd2722f3',
  beer:'photo-1535958636474-b021ee887b13',
  'soft-drink':'photo-1551024709-8f23befc6f87',
  dessert:'photo-1488477181946-6428a0291777'
};
function fetchImage(key,id) {
 return new Promise((resolve)=>{
  const file=path.join(out,key+'.jpg');
  if(fs.existsSync(file)&&fs.statSync(file).size>3000){console.log('Exists',key);return resolve();}
  const url='https://images.unsplash.com/'+id+'?auto=format&fit=crop&w=480&h=320&q=74';
  const req=https.get(url,{timeout:15000},res=>{
   if(res.statusCode!==200||!String(res.headers['content-type']).startsWith('image/')){
    console.warn('Skipped',key,'HTTP',res.statusCode);res.resume();return resolve();
   }
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
    const bytes=Buffer.concat(chunks);
    if(bytes.length>3000){fs.writeFileSync(file,bytes);console.log('Saved',key,bytes.length);}
    else console.warn('Skipped short image',key);
    resolve();
   });
  });
  req.on('timeout',()=>req.destroy(new Error('timeout')));
  req.on('error',err=>{console.warn('Skipped',key,err.message);resolve();});
 });
}
(async()=>{for(const [key,id] of Object.entries(photos)) await fetchImage(key,id);
 console.log('Done. Photos are local and usable offline. Missing images retain colored placeholders.');
})();
