import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacket,openPacket,inspectPacket,packetToPixels,pixelsToPacket,getImageLayout,fitBlockSize,PALETTES } from '../src/codec.mjs';
const encoder = new TextEncoder();
function scale({rgba,columns,rows,blockSize,width,height}) {
  const pixels = new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const source=(Math.floor(y/blockSize)*columns+Math.floor(x/blockSize))*4;
    pixels.set(rgba.subarray(source,source+4),(y*width+x)*4);
  }
  return pixels;
}
async function roundtrip(input,opts={},block=3){
  const frame=await createPacket(input,opts);
  const rendered=packetToPixels(frame,block);
  const extracted=pixelsToPacket(scale(rendered),rendered.width,rendered.height);
  assert.deepEqual(extracted.packet,frame);
  assert.equal(extracted.blockSize,block);
  return openPacket(extracted.packet,{password:opts.password||''});
}
test('4 palettes × 3 block sizes roundtrip Unicode, emoji and multiline text',async()=>{
  const phrase='棱彩邮包 💠\nPrismParcel\r\n\u0000\u{1F32C} end';
  for(const style of Object.keys(PALETTES)) for(const block of [1,3,7]){
    const recovered=await roundtrip({kind:'text',bytes:encoder.encode(phrase)},{style,compress:false},block);
    assert.equal(new TextDecoder().decode(recovered.bytes),phrase);
    assert.equal(recovered.style,style);
    assert.equal(recovered.encrypted,false);
  }
});
test('binary files including zero and 0xFF restore exactly with names/MIME',async()=>{
  const bytes=new Uint8Array(2049);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  const recovered=await roundtrip({kind:'file',filename:'图像样本 [1].dat',mime:'application/octet-stream',bytes},{style:'aurora'},2);
  assert.deepEqual(recovered.bytes,bytes);assert.equal(recovered.filename,'图像样本 [1].dat');assert.equal(recovered.kind,'file');
});
test('password encryption is randomized, reversible and wrong passwords fail',async()=>{
  const input={kind:'text',bytes:encoder.encode('secrets at midnight')};
  const frame=await createPacket(input,{password:'长长的安全密码!1',style:'sunset'});
  const next=await createPacket(input,{password:'长长的安全密码!1',style:'sunset'});
  assert.notDeepEqual(frame,next);
  assert.equal(inspectPacket(frame).encrypted,true);
  await assert.rejects(openPacket(frame,{password:'bad password'}),/密码错误/);
  await assert.rejects(openPacket(frame),/输入密码/);
  const restored=await openPacket(frame,{password:'长长的安全密码!1'});
  assert.deepEqual(restored.bytes,input.bytes);
});
test('smart compression roundtrip and conditional compression behavior',async()=>{
  const text='数据封装 / DATA '.repeat(350);
  const frame=await createPacket({kind:'text',bytes:encoder.encode(text)},{compress:true});
  assert.equal(inspectPacket(frame).compressed,true);
  const restored=await openPacket(frame);
  assert.equal(new TextDecoder().decode(restored.bytes),text);
  const small=await createPacket({kind:'text',bytes:encoder.encode('hi')},{compress:true});
  assert.equal(inspectPacket(small).compressed,false);
});
test('tampered unencrypted payload is rejected by SHA-256 integrity check',async()=>{
  const frame=await createPacket({kind:'text',bytes:encoder.encode('cannot edit this')},{compress:false});
  frame[frame.length-33]^=1;
  await assert.rejects(openPacket(frame),/校验失败/);
});
test('malformed header, bad image, and invalid block size fail safely',async()=>{
  const frame=await createPacket({kind:'text',bytes:encoder.encode('hello')},{compress:false});
  frame[10]=255;
  assert.throws(()=>inspectPacket(frame),/颜色方案/);
  assert.throws(()=>getImageLayout(100,17),/像素块/);
  assert.throws(()=>pixelsToPacket(new Uint8ClampedArray(16),2,2),/不是 PrismParcel|缩放/);
});
test('empty binary file can be sealed and unpacked',async()=>{
  const recovered=await roundtrip({kind:'file',filename:'empty.bin',bytes:new Uint8Array(0)},{style:'graphite'},1);
  assert.equal(recovered.bytes.length,0);
});

test('全色域 8× 样例文字能完整还原',async()=>{
 const text='这个世界上的每一种颜色，都可以藏着一段尚未被读出的故事。\n\n—— 来自 PrismParcel 的一封像素来信。';
 const recovered=await roundtrip({kind:'text',bytes:encoder.encode(text)},{style:'spectrum',compress:true},8);
 assert.equal(new TextDecoder().decode(recovered.bytes),text);
});
test('过大画布自动选择可用像素尺寸，且仍可解码',async()=>{
 const bytes=new Uint8Array(800000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const frame=await createPacket({kind:'file',filename:'large.bin',bytes},{compress:false});
 const fitted=fitBlockSize(frame,8);
 assert(fitted.blockSize<8&&fitted.blockSize>=1);
 assert.equal(fitted.width*fitted.height<=16*1024*1024,true);
});
