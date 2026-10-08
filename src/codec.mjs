/**
 * PrismParcel v2: versioned, lossless pixel transport for text and arbitrary files.
 * The visual palette is never a security mechanism. Password mode uses AES-256-GCM.
 * No external dependencies. All multi-byte integers use big-endian order.
 */
export const VERSION = 2;
export const MAGIC = new Uint8Array([80, 82, 83, 77, 80, 88, 76, 50]); // PRSMPXL2
export const HEADER_BYTES = 48; // 16 unmodified RGB pixels for format detection
export const MAX_FRAME_BYTES = 12 * 1024 * 1024;
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024; // conservative browser canvas budget
export const MAX_CANVAS_SIDE = 16384;
export const KDF_ITERATIONS = 210_000;
const UTF8 = new TextEncoder();
const DECODE = new TextDecoder('utf-8', { fatal: true });
const DIGEST_BYTES = 32;
const palette = (hex) => hex.map(h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]);
export const PALETTES = Object.freeze({
  spectrum: { id:0, name:'全色域', colors:null, hint:'高密度 RGB · 文件更紧凑' },
  aurora: { id:1, name:'极光', colors:palette(['#10152c','#182646','#213858','#244f6b','#276478','#287c86','#37918a','#58a591','#7eb69d','#b3c3a9','#d2c7bc','#d6b9ce','#b69dd1','#8779bd','#5b569a','#302b64']), hint:'16 色 · 蓝绿渐变' },
  sunset: { id:2, name:'落日', colors:palette(['#291b35','#422340','#5b2d47','#77354d','#944051','#b75155','#d16b59','#de865e','#e7a069','#f3b97b','#f8cf96','#f5dcb7','#eac5b0','#d49fa0','#a66f8b','#6d4872']), hint:'16 色 · 暖色序列' },
  graphite: { id:3, name:'石墨', colors:palette(['#101820','#202932','#303941','#404951','#505960','#606a71','#707a80','#808a90','#909aa0','#a0aab0','#b0bac0','#c0cad0','#d0d9dd','#e0e7e9','#edf1f1','#ffffff']), hint:'16 色 · 单色阶' }
});
const STYLE_BY_ID = Object.fromEntries(Object.entries(PALETTES).map(([key,value]) => [value.id,key]));

function assert(ok, message) { if (!ok) throw new Error(message); }
function bytesEqual(a,b) { if (a.length !== b.length) return false; let diff = 0; for (let i=0;i<a.length;i++) diff |= a[i]^b[i]; return diff===0; }
function join(...arrays) { const result=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0)); let pos=0; for(const a of arrays){result.set(a,pos);pos+=a.length;} return result; }
async function checksum(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256',data)); }
async function deriveKey(password,salt) {
  const material=await crypto.subtle.importKey('raw',UTF8.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:KDF_ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function requireCrypto(){assert(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues,'需要安全上下文：请通过 localhost 或 HTTPS 打开本工具');}

async function serialize({kind,filename='',mime='',bytes}) {
  assert(kind==='text'||kind==='file','未知的数据类型');
  assert(bytes instanceof Uint8Array,'数据必须为 Uint8Array');
  const filenameBytes=UTF8.encode(kind==='file'?filename:'');
  const mimeBytes=UTF8.encode(kind==='file'?mime:'text/plain;charset=utf-8');
  assert(filenameBytes.length<=1024&&mimeBytes.length<=1024,'文件名或 MIME 类型过长');
  assert(bytes.length<=MAX_FRAME_BYTES-512,'输入文件超出当前版本的容量限制');
  const content=new Uint8Array(9+filenameBytes.length+mimeBytes.length+bytes.length);
  const view=new DataView(content.buffer);
  content[0]=kind==='text'?0:1;
  view.setUint16(1,filenameBytes.length);view.setUint16(3,mimeBytes.length);view.setUint32(5,bytes.length);
  content.set(filenameBytes,9);content.set(mimeBytes,9+filenameBytes.length);content.set(bytes,9+filenameBytes.length+mimeBytes.length);
  return join(content,await checksum(content));
}
async function deserialize(payload) {
  assert(payload.length>=41,'图像内容不完整');
  const content=payload.subarray(0,payload.length-DIGEST_BYTES);
  const expected=payload.subarray(payload.length-DIGEST_BYTES);
  assert(bytesEqual(await checksum(content),expected),'内容校验失败，图片可能被修改');
  const view=new DataView(content.buffer,content.byteOffset,content.byteLength);
  assert(content[0]===0||content[0]===1,'未知的数据类型');
  const nameLength=view.getUint16(1),mimeLength=view.getUint16(3),dataLength=view.getUint32(5);
  assert(nameLength<=1024&&mimeLength<=1024&&9+nameLength+mimeLength+dataLength===content.length,'内容长度校验失败');
  return {kind:content[0]===0?'text':'file',filename:DECODE.decode(content.subarray(9,9+nameLength)),mime:DECODE.decode(content.subarray(9+nameLength,9+nameLength+mimeLength)),bytes:content.slice(9+nameLength+mimeLength)};
}
async function gzip(data) {
  if(!globalThis.CompressionStream) return null;
  const stream=new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(data) {
  assert(globalThis.DecompressionStream,'当前浏览器不支持解压 GZIP，请换用较新的浏览器');
  const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;assert(length<=MAX_FRAME_BYTES,'解压后的内容超过安全上限');chunks.push(value);}
  } catch(error){await reader.cancel().catch(()=>{});throw error;}
  return join(...chunks);
}
/** @param {object} input bytes are raw Uint8Array; options are intentionally explicit */
export async function createPacket(input,{password='',style='spectrum',compress=true}={}){
  requireCrypto();assert(Object.hasOwn(PALETTES,style),'不支持的颜色方案');
  let payload=await serialize(input);
  let compressed=false;
  if(compress && payload.length>128){const candidate=await gzip(payload);if(candidate && candidate.length+16<payload.length){payload=candidate;compressed=true;}}
  const encrypted=password.length>0;
  const salt=new Uint8Array(16),iv=new Uint8Array(12);
  if(encrypted){crypto.getRandomValues(salt);crypto.getRandomValues(iv);payload=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await deriveKey(password,salt),payload));}
  assert(HEADER_BYTES+payload.length<=MAX_FRAME_BYTES,'数据太大，生成图片超出 12 MiB 的封装限制');
  const frame=new Uint8Array(HEADER_BYTES+payload.length);
  frame.set(MAGIC);
  frame[8]=VERSION;frame[9]=(encrypted?1:0)|(compressed?2:0);frame[10]=PALETTES[style].id;
  new DataView(frame.buffer).setUint32(12,payload.length);
  frame.set(salt,16);frame.set(iv,32);frame.set(payload,HEADER_BYTES);
  return frame;
}
export function inspectPacket(frame){
  assert(frame instanceof Uint8Array && frame.length>=HEADER_BYTES,'数据头不完整');
  assert(bytesEqual(frame.subarray(0,8),MAGIC),'不是 PrismParcel v2 格式');
  assert(frame[8]===VERSION,'暂不支持当前图片的协议版本');
  assert((frame[9]&~3)===0&&frame[11]===0&&frame.subarray(44,48).every(v=>v===0),'未知的封装格式标志');
  const style=STYLE_BY_ID[frame[10]];
  assert(style!==undefined,'未知的颜色方案');
  const length=new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getUint32(12);
  assert(length>=41&&length<=MAX_FRAME_BYTES-HEADER_BYTES&&length+HEADER_BYTES===frame.length,'封装长度不匹配');
  return {encrypted:Boolean(frame[9]&1),compressed:Boolean(frame[9]&2),style,version:VERSION,storedBytes:length};
}
export async function openPacket(frame,{password=''}={}){
  requireCrypto();const info=inspectPacket(frame);
  let payload=frame.subarray(HEADER_BYTES);
  if(info.encrypted){assert(password.length>0,'此图片设置了密码，请先输入密码');try{payload=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:frame.subarray(32,44)},await deriveKey(password,frame.subarray(16,32)),payload));}catch{throw new Error('密码错误，或者图片数据已损坏');}}
  if(info.compressed){try{payload=await gunzip(payload);}catch(error){throw new Error(`压缩数据损坏：${error.message}`);}}
  return {...await deserialize(payload),...info};
}
export function getImageLayout(frameOrLength,blockSize=2,style='spectrum'){
  assert(Number.isInteger(blockSize)&&blockSize>=1&&blockSize<=16,'像素块尺寸必须在 1～16 之间');
  if(frameOrLength instanceof Uint8Array){style=STYLE_BY_ID[frameOrLength[10]];frameOrLength=frameOrLength.length;}
  assert(Object.hasOwn(PALETTES,style),'未知颜色方案');
  const length=frameOrLength;
  const cells=style==='spectrum'?Math.ceil(length/3):16+(length-HEADER_BYTES)*2;
  const columns=Math.max(1,Math.ceil(Math.sqrt(cells)));
  const rows=Math.ceil(cells/columns);
  const width=columns*blockSize,height=rows*blockSize;
  assert(width<=MAX_CANVAS_SIDE&&height<=MAX_CANVAS_SIDE&&width*height<=MAX_CANVAS_PIXELS,'图片超过当前浏览器的绘制上限，请减小像素尺寸，或改用全色域');
  return {columns,rows,width,height,blockSize,style,cells};
}
/** Returns RGBA pixels at 1 cell per pixel, caller scales with nearest-neighbor. */
export function packetToPixels(frame,blockSize=2){
  const info=inspectPacket(frame);const layout=getImageLayout(frame,blockSize,info.style);
  const rgba=new Uint8ClampedArray(layout.columns*layout.rows*4);
  for(let p=0;p<rgba.length;p+=4){rgba[p]=rgba[p+1]=rgba[p+2]=255;rgba[p+3]=255;}
  const put=(pixel,r,g,b)=>{const i=pixel*4;rgba[i]=r;rgba[i+1]=g;rgba[i+2]=b;};
  if(info.style==='spectrum'){
    for(let i=0;i<frame.length;i++)rgba[Math.floor(i/3)*4+i%3]=frame[i];
  } else {
    for(let i=0;i<HEADER_BYTES;i++)rgba[Math.floor(i/3)*4+i%3]=frame[i];
    const colors=PALETTES[info.style].colors;
    for(let i=HEADER_BYTES;i<frame.length;i++){
      put(16+(i-HEADER_BYTES)*2,...colors[frame[i]>>4]);
      put(17+(i-HEADER_BYTES)*2,...colors[frame[i]&15]);
    }
  }
  return {...layout,rgba};
}
/** Decode a native-resolution unaltered PNG; auto-detect cell size and palette. */
export function pixelsToPacket(rgba,width,height){
  assert(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width*height<=MAX_CANVAS_PIXELS&&rgba.length===width*height*4,'无效图片或像素数量超出限制');
  const sample=(pixel,block,cols)=>{const x=(pixel%cols)*block+Math.floor(block/2);const y=Math.floor(pixel/cols)*block+Math.floor(block/2);const i=(y*width+x)*4;return [rgba[i],rgba[i+1],rgba[i+2]];};
  let damagedCandidate=false;
  for(let block=1;block<=16;block++){
    if(width%block||height%block)continue;
    const cols=width/block,available=cols*(height/block);
    if(available<16)continue;
    const header=new Uint8Array(HEADER_BYTES);
    for(let i=0;i<16;i++){const c=sample(i,block,cols);header.set(c,i*3);}
    if(!bytesEqual(header.subarray(0,8),MAGIC))continue;
    assert(header[8]===VERSION,'图片采用不支持的协议版本');
    const style=STYLE_BY_ID[header[10]];
    assert(style!==undefined,'图像颜色方案不受支持');
    const length=new DataView(header.buffer).getUint32(12);
    const total=HEADER_BYTES+length;
    // A magic-only match may be a false candidate at a wrong block size.
    // Prefer checking all possible sizes before reporting corruption.
    if(length<41||total>MAX_FRAME_BYTES){damagedCandidate=true;continue;}
    const needed=style==='spectrum'?Math.ceil(total/3):16+length*2;
    if(needed>available){damagedCandidate=true;continue;}
    // Exact dimensions are part of the encoding layout: prevents a false
    // hit on a smaller block size in an image made with larger blocks.
    const expected=getImageLayout(total,block,style);
    if(expected.width!==width||expected.height!==height){damagedCandidate=true;continue;}
    const frame=new Uint8Array(total);frame.set(header);
    if(style==='spectrum'){
      for(let i=HEADER_BYTES;i<total;i++)frame[i]=sample(Math.floor(i/3),block,cols)[i%3];
    } else {
      const paletteColors=PALETTES[style].colors;
      const pick=(index)=>{const color=sample(index,block,cols);const value=paletteColors.findIndex(p=>p[0]===color[0]&&p[1]===color[1]&&p[2]===color[2]);assert(value>=0,'颜色被修改，无法无损恢复。请上传原始 PNG');return value;};
      for(let i=HEADER_BYTES;i<total;i++)frame[i]=(pick(16+(i-HEADER_BYTES)*2)<<4)|pick(17+(i-HEADER_BYTES)*2);
    }
    inspectPacket(frame);
    return {packet:frame,blockSize:block,...inspectPacket(frame)};
  }
  throw new Error(damagedCandidate?'图片内容不完整或已损坏，请使用原始 PNG':'这不是 PrismParcel 图片，或图片已被缩放、修改');
}

/** Choose the requested block size or the largest one the current canvas budget can support. */
export function fitBlockSize(frame,requestedSize){
  for(let size=requestedSize;size>=1;size--){
    try{return {blockSize:size,...getImageLayout(frame,size)};}
    catch(error){if(size===1)throw error;}
  }
  throw new Error('数据无法放进一张 PNG 图片');
}
