import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { receiptSvg } from './receipt.js';
import { svgPng } from './render-svg.js';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export async function renderMedia(content,format) {
 const design=content.design || {}, background=design.background || '#0f1e33', color=design.text || '#eff6ff', accent=design.accent || '#2f6feb';
 const lines=String(content.text).split('\n').flatMap(line=>{
  const words=line.split(/\s+/), rows=[];let row='';
  for(const word of words) {if((row+' '+word).length>78) {rows.push(row);row=word;} else row+=(row?' ':'')+word;}
  rows.push(row);return rows;
 }).slice(0,160);
 const pages=[];
 if(design.layout==='clean_receipt')for(const svg of receiptSvg(content))pages.push(await svgPng(svg));
 else
 for(let offset=0;offset<lines.length;offset+=32) {
  const chunk=lines.slice(offset,offset+32),height=140+chunk.length*30+48;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="'+height+'"><rect width="100%" height="100%" fill="'+background+'"/><rect width="100%" height="96" fill="'+accent+'"/><text x="42" y="58" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="bold" fill="#fff">'+escape(design.title || 'Jarvis Trading')+'</text>'+chunk.map((line,index)=>'<text x="42" y="'+(140+index*30)+'" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="'+color+'">'+escape(line)+'</text>').join('')+'</svg>';
  pages.push(await svgPng(svg));
 }
 if(format==='image') {
  if(pages.length>1) {
   const images=await Promise.all(pages.map(async input=>({input,...await sharp(input).metadata()})));
   const total=images.reduce((n,x)=>n+x.height,0);let top=0;
   return {buffer:await sharp({create:{width:1000,height:total,channels:4,background}}).composite(images.map(x=>{const item={input:x.input,left:0,top};top+=x.height;return item;})).png().toBuffer(),mime:'image/png',filename:'jarvis-update.png'};
  }
  return {buffer:pages[0],mime:'image/png',filename:'jarvis-update.png'};
 }
 const pdf=await PDFDocument.create();
 for(const png of pages) {const image=await pdf.embedPng(png);const page=pdf.addPage([595,842]);const scale=Math.min(555/image.width,802/image.height);page.drawImage(image,{x:20,y:842-20-image.height*scale,width:image.width*scale,height:image.height*scale});}
 return {buffer:Buffer.from(await pdf.save()),mime:'application/pdf',filename:'jarvis-report.pdf'};
}

