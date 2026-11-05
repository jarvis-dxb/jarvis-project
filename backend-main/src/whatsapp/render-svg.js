import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {outlineSvgText} from './font-outlines.js';

const require=createRequire(import.meta.url);
let rendererReady;
let identity;
export function mediaRendererIdentity(){
 if(!identity){
  try{
   const hash=createHash('sha256');
   for(const file of ['render-svg.js','font-outlines.js','media.js','receipt.js','fonts/DejaVuSans.ttf','fonts/DejaVuSans-Bold.ttf'])hash.update(readFileSync(new URL(file,import.meta.url)));
   identity={engine:'outlined-glyphs-v3',build:hash.digest('hex').slice(0,16),node:process.versions.node,platform:process.platform};
  }catch{return {engine:'outlined-glyphs-v3',build:'unavailable',node:process.versions.node,platform:process.platform};}
 }
 return {...identity};
}
function ready() {
 return rendererReady ||= readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')).then(bytes=>initWasm(bytes));
}
export async function svgPng(svg) {
 const outlined=outlineSvgText(svg);
 await ready();
 // Text is already geometry: even the SVG rasterizer receives no font data
 // and performs no font lookup. API previews and worker sends use this path.
 const renderer=new Resvg(outlined,{font:{loadSystemFonts:false}});
 let image;
 try {
  image=renderer.render();
  return Buffer.from(image.asPng());
 }finally{image?.free();renderer.free();}
}
