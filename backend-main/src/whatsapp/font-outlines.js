import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {create} from 'fontkit';

let fonts;
function bundledFonts(){
 if(fonts)return fonts;
 try{
  const expected={'DejaVuSans.ttf':'7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954','DejaVuSans-Bold.ttf':'e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724'};
  const load=name=>{
   const bytes=readFileSync(new URL('./fonts/'+name,import.meta.url));
   if(createHash('sha256').update(bytes).digest('hex')!==expected[name])throw Error('Bundled font checksum mismatch');
   return create(bytes);
  };
  const regular=load('DejaVuSans.ttf'),bold=load('DejaVuSans-Bold.ttf');
  for(const font of [regular,bold])for(const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'){
   if(!font.hasGlyphForCodePoint(char.codePointAt(0)))throw Error('Font character missing');
  }
  return fonts={regular,bold};
 }catch{throw Error('Bundled notification fonts could not be validated. Image/PDF was not generated.');}
}
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const decode=value=>value.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,(_,hex,decimal,name)=>{
 if(hex||decimal)return String.fromCodePoint(parseInt(hex||decimal,hex?16:10));
 return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name.toLowerCase()];
});
const number=value=>Number(value.toFixed(5));
function glyphPaths(text,attributes){
 const {regular,bold}=bundledFonts();
 const font=attributes['font-weight']==='bold'||Number(attributes['font-weight'])>=600?bold:regular;
 // Unsupported emoji retain their code point as readable ASCII instead of a
 // missing-glyph square. Latin text, numbers and monetary values stay exact.
 const value=Array.from(text.replace(/[\r\n\t]/g,' ')).filter(char=>char!=='\uFE0F').map(char=>
  font.hasGlyphForCodePoint(char.codePointAt(0))?char:'[U+'+char.codePointAt(0).toString(16).toUpperCase()+']').join('');
 const run=font.layout(value),size=Number(attributes['font-size']||16),scale=size/font.unitsPerEm;
 let x=Number(attributes.x||0),y=Number(attributes.y||0);
 if(![x,y,size].every(Number.isFinite)||size<=0)throw Error('Invalid notification text geometry');
 if(attributes['text-anchor']==='end')x-=run.advanceWidth*scale;
 if(attributes['text-anchor']==='middle')x-=run.advanceWidth*scale/2;
 const paths=[];
 for(let i=0;i<run.glyphs.length;i++){
  const glyph=run.glyphs[i],position=run.positions[i];
  if(glyph.id===0)throw Error('Notification glyph could not be outlined');
  const path=glyph.path.toSVG();
  if(path)paths.push(`<path transform="translate(${number(x+position.xOffset*scale)} ${number(y-position.yOffset*scale)}) scale(${number(scale)} ${number(-scale)})" d="${path}"/>`);
  x+=position.xAdvance*scale;y-=position.yAdvance*scale;
 }
 return `<g fill="${escape(attributes.fill||'#000000')}">${paths.join('')}</g>`;
}

// Only our own receipt/classic SVG builders reach this function. They generate
// plain, XML-escaped <text> nodes, never arbitrary SVG/HTML supplied by a user.
export function outlineSvgText(svg){
 const result=String(svg).replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/g,(_node,raw,content)=>{
  if(content.includes('<'))throw Error('Unsupported nested notification text');
  const attributes=Object.fromEntries(Array.from(raw.matchAll(/([\w-]+)="([^"]*)"/g),match=>[match[1],decode(match[2])]));
  return glyphPaths(decode(content),attributes);
 });
 if(/<text\b|<tspan\b|<textPath\b/i.test(result))throw Error('Unconverted notification text; image/PDF was not generated');
 return result;
}
