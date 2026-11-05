import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {outlineSvgText} from '../src/whatsapp/font-outlines.js';
import {svgPng,mediaRendererIdentity} from '../src/whatsapp/render-svg.js';
const svg=(anchor='start',content='AB19 +9 USDT')=>`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="white"/><text x="200" y="65" text-anchor="${anchor}" font-family="NonexistentFont" font-size="24" fill="#000">${content}</text></svg>`;
test('letters become vector paths before rasterizing, including escaped characters and unsupported-emoji fallback',()=>{
 for(const value of ['Jarvis +9 USDT','&lt;script&gt;&amp;hello','سبورة','🚀']){
  const outlined=outlineSvgText(svg('start',value));assert.match(outlined,/<path /);assert.doesNotMatch(outlined,/<text\b|font-family|<script>|<tspan\b/);
 }
 assert.throws(()=>outlineSvgText(svg('start','<tspan>AB</tspan>')),/nested notification text/);
});
test('right and centre aligned monetary text retains its visual anchor without any renderer font lookup',async()=>{
 const bounds={};
 for(const anchor of ['start','middle','end']){
  const {data,info}=await sharp(await svgPng(svg(anchor))).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const xs=[];for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*3]<100)xs.push(x);
  assert.ok(xs.length>100);bounds[anchor]=[Math.min(...xs),Math.max(...xs)];
 }
 assert.ok(bounds.start[0]>=200);assert.ok(bounds.end[1]<=200);
 assert.ok(bounds.middle[0]<200&&bounds.middle[1]>200);
 assert.ok(Math.abs((bounds.middle[0]+bounds.middle[1])/2-200)<5);
});
test('renderer identity is stable and contains only sanitized implementation identifiers',()=>{
 const identity=mediaRendererIdentity();assert.equal(identity.engine,'outlined-glyphs-v3');assert.match(identity.build,/^[a-f0-9]{16}$/);
 assert.deepEqual(mediaRendererIdentity(),identity);assert.deepEqual(Object.keys(identity).sort(),['build','engine','node','platform']);
 assert.ok(!JSON.stringify(identity).includes('Users/'));
});
