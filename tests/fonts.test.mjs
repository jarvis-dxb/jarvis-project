import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {configureBundledFonts} from '../scripts/hosting-config.mjs';

// Apply the same bootstrap BEFORE the native renderer is imported.
const fontDirectory=configureBundledFonts(process.env);
const {renderMedia}=await import('../backend-main/src/whatsapp/media.js');
const {receiptData,receiptSvg}=await import('../backend-main/src/whatsapp/receipt.js');
const sharp=(await import('sharp')).default;
const {PDFDocument}=await import('pdf-lib');

test('bundled fonts replace stale manual paths and are inherited by a worker process',()=>{
 const env={FONTCONFIG_FILE:'/old/deployment/missing.conf',FONTCONFIG_PATH:'/old/deployment'};
 configureBundledFonts(env);
 assert.equal(env.FONTCONFIG_PATH,fontDirectory);
 assert.equal(env.FONTCONFIG_FILE,path.join(fontDirectory,'fonts.conf'));
 const child=spawnSync(process.execPath,['-e',"console.log(JSON.stringify({file:process.env.FONTCONFIG_FILE,path:process.env.FONTCONFIG_PATH}))"],{env:{...process.env,...env},encoding:'utf8',windowsHide:true});
 assert.equal(child.status,0);
 assert.deepEqual(JSON.parse(child.stdout),{file:env.FONTCONFIG_FILE,path:env.FONTCONFIG_PATH});
 const config=fs.readFileSync(env.FONTCONFIG_FILE,'utf8');
 assert.match(config,/<dir prefix="relative">\.<\/dir>/);
 assert.match(config,/<family>Arial<\/family>/);
 assert.match(config,/<family>DejaVu Sans<\/family>/);
 assert.ok(fs.existsSync(path.join(fontDirectory,'LICENSE-DejaVu.txt')));
});

test('regular and bold fonts contain the actual receipt characters rather than missing glyphs',()=>{
 for(const filename of ['DejaVuSans.ttf','DejaVuSans-Bold.ttf']){
  const b=fs.readFileSync(path.join(fontDirectory,filename));assert.equal(b.readUInt32BE(0),0x10000);
  const tables=new Map();for(let i=0;i<b.readUInt16BE(4);i++)tables.set(b.toString('ascii',12+i*16,16+i*16),b.readUInt32BE(20+i*16));
  const cmap=tables.get('cmap');let groups=[];
  for(let i=0;i<b.readUInt16BE(cmap+2);i++){
   const offset=cmap+b.readUInt32BE(cmap+8+8*i);
   if(b.readUInt16BE(offset)!==12)continue;
   groups=Array.from({length:b.readUInt32BE(offset+12)},(_,n)=>[b.readUInt32BE(offset+16+n*12),b.readUInt32BE(offset+20+n*12),b.readUInt32BE(offset+24+n*12)]);break;
  }
  assert.ok(groups.length);
  for(const c of 'Jarvis PROFIT LOSS +12.34 USDT ✓ — سبورة')assert.ok(groups.some(([start,end,glyph])=>c.codePointAt(0)>=start&&c.codePointAt(0)<=end&&glyph+c.codePointAt(0)-start>0),filename+' missing '+c);
 }
});

test('filled/profit/loss image and PDF use the same bundled-font receipt without changing financial values',async()=>{
 for(const [kind,pnl,label] of [['order_accepted',null,'TRADE EXECUTED'],['take_profit_hit',10,'PROFIT'],['stop_loss_hit',-5,'LOSS']]){
  const receipt=receiptData({kind,source:'sample',occurred_at:1793282400000,data:{setupName:'SAMPLE - BTC strategy',account:'Sample Account',network:'mainnet',symbol:'BTCUSDT',side:'long',status:'closed',price:50000,entryPrice:50000,exitPrice:50500,quantity:0.02,margin:100,leverage:10,pnl,totalFees:pnl===null?undefined:1,feesComplete:pnl!==null,positionClosed:pnl!==null,currency:'USDT'}});
  assert.equal(receipt.heading,label);
  if(pnl!==null)assert.equal(receipt.net,(pnl-1>0?'+':'')+(pnl-1)+' USDT');
  const content={receipt,text:'SAMPLE DATA - no trade placed',design:{layout:'clean_receipt',title:'Jarvis'}};
  assert.match(receiptSvg(content)[0],/font-family="DejaVu Sans, Arial, sans-serif"/);
  const image=await renderMedia(content,'image');const pdf=await renderMedia(content,'pdf');
  assert.equal((await sharp(image.buffer).metadata()).width,1000);
  assert.equal((await PDFDocument.load(pdf.buffer)).getPageCount(),1);
  if(process.env.JARVIS_FONT_PREVIEW_DIR&&label==='PROFIT'){
   fs.writeFileSync(path.join(process.env.JARVIS_FONT_PREVIEW_DIR,'whatsapp-font-fixed-sample.png'),image.buffer);
   fs.writeFileSync(path.join(process.env.JARVIS_FONT_PREVIEW_DIR,'whatsapp-font-fixed-sample.pdf'),pdf.buffer);
  }
 }
 const plain={text:'BTCUSDT LONG\nProfit +9 USDT\nFees 1 USDT',design:{title:'Jarvis'}};
 assert.equal((await sharp((await renderMedia(plain,'image')).buffer).metadata()).width,1000);
 assert.equal((await PDFDocument.load((await renderMedia(plain,'pdf')).buffer)).getPageCount(),1);
});
