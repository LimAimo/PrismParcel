import {createPacket,openPacket,packetToPixels,pixelsToPacket,MAX_CANVAS_PIXELS,MAX_FRAME_BYTES,PALETTES,fitBlockSize} from './codec.mjs';

const $ = (id) => document.getElementById(id);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', {fatal:true});
const state = {tab:'encode',source:'text',style:'spectrum',sourceFile:null,imageFile:null,previewBlob:null,recovered:null,busy:false};
const formatBytes = (value) => value<1024 ? `${value.toLocaleString('zh-CN')} B` : value<1024**2 ? `${(value/1024).toFixed(1)} KB` : `${(value/1024**2).toFixed(2)} MB`;
const safeName = (value,fallback='parcel') => (value||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+$/,'').slice(0,180).trim()||fallback;
let toastTimer;

function toast(message,isError=false) {
  const host=$('toast-region');host.replaceChildren();
  const note=document.createElement('div');note.className=`toast${isError?' is-error':''}`;note.textContent=message;host.append(note);
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{note.classList.add('is-leaving');setTimeout(()=>note.remove(),300);},4600);
}
function showBusy(title,detail='整个过程都在本地浏览器中完成') {
  state.busy=true;
  $('busy-title').textContent=title;$('busy-description').textContent=detail;
  $('busy-overlay').classList.add('is-visible');$('busy-overlay').setAttribute('aria-hidden','false');
  $('generate-button').disabled=true;$('restore-button').disabled=true;
}
function hideBusy() {
  state.busy=false;$('busy-overlay').classList.remove('is-visible');$('busy-overlay').setAttribute('aria-hidden','true');
  $('generate-button').disabled=false;$('restore-button').disabled=false;
}
const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function switchTab(tab){
  if(state.busy||state.tab===tab)return;
  state.tab=tab;
  $('panel-encode').hidden=tab!=='encode';$('panel-decode').hidden=tab!=='decode';
  $('tab-glider').parentElement.dataset.active=tab;
  $$('.workspace-tab').forEach(button=>{const chosen=button.dataset.tab===tab;button.classList.toggle('is-current',chosen);button.setAttribute('aria-selected',String(chosen));button.tabIndex=chosen?0:-1;});
}
function switchSource(source){
  resetPreview();
  state.source=source;$('source-text-panel').hidden=source!=='text';$('source-file-panel').hidden=source!=='file';
  $('source-track').parentElement.dataset.active=source;
  $$('.choice-button').forEach(button=>{const chosen=button.dataset.source===source;button.classList.toggle('is-current',chosen);button.setAttribute('aria-checked',String(chosen));});
}
function selectPalette(style){
  if(!Object.hasOwn(PALETTES,style))return;
  if(state.style!==style)resetPreview();
  state.style=style;
  $$('.palette-card').forEach(button=>{const chosen=button.dataset.style===style;button.classList.toggle('is-selected',chosen);button.setAttribute('aria-checked',String(chosen));});
  $('palette-description').textContent=PALETTES[style].hint;
}
function resetPreview(){
  state.previewBlob=null;$('result-canvas').hidden=true;$('preview-placeholder').hidden=false;
  $('download-button').disabled=true;$('reset-preview').disabled=true;
  $('preview-mode-label').textContent='等待生成';$('stat-dimensions').textContent='—';$('stat-size').textContent='—';$('stat-security').textContent='未生成';
}
function downloadBlob(blob,name){
  const objectURL=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=objectURL;a.download=safeName(name);a.style.display='none';document.body.append(a);a.click();a.remove();
  // Browsers may need the object URL until after the download has started.
  setTimeout(()=>URL.revokeObjectURL(objectURL),60_000);
}
async function renderFrame(frame,blockSize){
  const {columns,rows,width,height,rgba}=packetToPixels(frame,blockSize);
  const canvas=$('result-canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw new Error('无法创建 PNG 画布，请减小像素尺寸');
  // Work with a 1:1 logical pixel canvas first, then nearest-neighbor-scale.
  if(blockSize===1){ctx.putImageData(new ImageData(rgba,columns,rows),0,0);}
  else {
    const tile=document.createElement('canvas');tile.width=columns;tile.height=rows;
    const tileCtx=tile.getContext('2d',{alpha:false});if(!tileCtx)throw new Error('无法初始化像素缓冲区');
    tileCtx.putImageData(new ImageData(rgba,columns,rows),0,0);
    ctx.imageSmoothingEnabled=false;ctx.drawImage(tile,0,0,width,height);
    tile.width=tile.height=0;
  }
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('无法生成 PNG，请减小像素尺寸或文件大小')),'image/png'));
  return {blob,width,height};
}
async function generate(){
  if(state.busy)return;
  let input;
  if(state.source==='text') {
    const text=$('plain-text').value;if(text.length===0){toast('请先输入文字',true);$('plain-text').focus();return;}
    input={kind:'text',bytes:ENCODER.encode(text)};
  } else {
    if(!state.sourceFile){toast('请先选择文件',true);return;}
    input={kind:'file',filename:state.sourceFile.name,mime:state.sourceFile.type||'application/octet-stream'};
  }
  if(state.source==='file'&&state.sourceFile.size>MAX_FRAME_BYTES-512){toast('文件太大：请使用不超过约 12 MiB 的文件。',true);return;}
  if(state.source==='text'&&input.bytes.length>MAX_FRAME_BYTES-512){toast('文字内容超过当前容量限制。',true);return;}
  const protectedMode=$('encryption-switch').checked;
  const password=protectedMode?$('encrypt-password').value:'';
  if(protectedMode&&[...password].length<8){toast('密码至少需要 8 个字符。',true);$('encrypt-password').focus();return;}
  showBusy('正在封装你的数据…','压缩、校验和密码加密都在本地完成');
  try{
    await nextPaint();
    if(state.source==='file')input.bytes=new Uint8Array(await state.sourceFile.arrayBuffer());
    const frame=await createPacket(input,{password,style:state.style,compress:$('compression-switch').checked});
    $('busy-title').textContent='正在绘制像素…';await nextPaint();
    const chosen=Number($('pixel-size').value);
    const fit=fitBlockSize(frame,chosen);
    const {blob,width,height}=await renderFrame(frame,fit.blockSize);
    state.previewBlob=blob;
    $('preview-placeholder').hidden=true;$('result-canvas').hidden=false;
    $('download-button').disabled=false;$('reset-preview').disabled=false;
    $('preview-mode-label').textContent=PALETTES[state.style].name;
    $('stat-dimensions').textContent=`${width} × ${height} · ${fit.blockSize}×`;
    $('stat-size').textContent=formatBytes(blob.size);
    $('stat-security').textContent=protectedMode?'AES-256':'无密码';
    toast(fit.blockSize<chosen?`生成成功。图片较大，像素尺寸已自动调整为 ${fit.blockSize}×。`:'PNG 已生成，可以下载。');
  }catch(error){resetPreview();toast(error instanceof Error?error.message:'生成失败，请重试。',true);console.error('PrismParcel encode:',error);}
  finally{hideBusy();}
}

async function decodeImageFile(file){
  const pngSignature=[137,80,78,71,13,10,26,10];
  if(file.size<24)throw new Error('图片文件为空或不完整，请重新选择 PNG');
  const signature=new Uint8Array(await file.slice(0,8).arrayBuffer());
  if(!pngSignature.every((n,i)=>signature[i]===n))throw new Error('请选择 PNG 图片，JPEG 和 WebP 不能用于还原');
  let bitmap;
  try{bitmap=await createImageBitmap(file,{colorSpaceConversion:'none'});}
  catch{try{bitmap=await createImageBitmap(file);}catch{throw new Error('无法读取这张 PNG，请确认文件没有损坏');}}
  try{
    if(bitmap.width*bitmap.height>MAX_CANVAS_PIXELS)throw new Error('图片分辨率过高，当前浏览器无法可靠处理');
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('无法读取图片像素');
    context.drawImage(bitmap,0,0);
    return pixelsToPacket(context.getImageData(0,0,bitmap.width,bitmap.height).data,bitmap.width,bitmap.height);
  } finally{bitmap.close();}
}
function showRecovered(result){
  state.recovered=result;
  $('decode-placeholder').hidden=true;$('decode-result').hidden=false;
  const isText=result.kind==='text';
  $('recovered-kind').textContent=isText?'TEXT / UTF-8':'FILE / BINARY';
  $('recovered-protection').textContent=result.encrypted?'已解密 · 校验通过':'校验通过';
  $('restore-state').textContent=`${PALETTES[result.style].name} · ${result.blockSize}×`;
  $('recovered-title').textContent=isText?'文字已还原':'文件已还原';
  $('recovered-meta').textContent=`${formatBytes(result.bytes.length)} · ${result.compressed?'使用了智能压缩 · ':''}${result.encrypted?'AES-256-GCM':'无密码编码'}`;
  $('recovered-text').hidden=!isText;$('recovered-file-card').hidden=isText;$('copy-text').hidden=!isText;
  if(isText){$('recovered-text').value=DECODER.decode(result.bytes);}
  else{$('recovered-file-name').textContent=result.filename||'已恢复的文件';$('recovered-file-size').textContent=`${formatBytes(result.bytes.length)} · ${result.mime||'未知类型'}`;}
}
async function restore(){
  if(state.busy)return;
  if(!state.imageFile){toast('请先选择 PNG 图片',true);return;}
  showBusy('正在读取像素…','自动识别像素大小、协议版本和调色板');
  try{
    await nextPaint();
    const extracted=await decodeImageFile(state.imageFile);
    $('busy-title').textContent=extracted.encrypted?'正在解锁与校验…':'正在校验数据…';await nextPaint();
    const recovered=await openPacket(extracted.packet,{password:$('decrypt-password').value});
    showRecovered({...recovered,blockSize:extracted.blockSize});
    toast('还原成功，内容校验通过');
  }catch(error){$('decode-placeholder').hidden=false;$('decode-result').hidden=true;state.recovered=null;$('restore-state').textContent='恢复失败';toast(error instanceof Error?error.message:'解析失败，请重试。',true);console.error('PrismParcel decode:',error);}
  finally{hideBusy();}
}
function attachDropzone(zoneId,inputId,onFile){
  const zone=$(zoneId),input=$(inputId);
  input.addEventListener('change',()=>onFile(input.files?.[0]||null));
  ['dragenter','dragover'].forEach(type=>zone.addEventListener(type,event=>{event.preventDefault();zone.classList.add('is-dragging');}));
  ['dragleave','drop'].forEach(type=>zone.addEventListener(type,event=>{event.preventDefault();zone.classList.remove('is-dragging');}));
  zone.addEventListener('drop',event=>{const file=event.dataTransfer?.files?.[0];if(file){onFile(file);input.value='';}});
}
function initTheme(){
  let theme='dark';try{theme=localStorage.getItem('prismparcel-theme')||'dark';}catch{}
  document.body.dataset.theme=theme==='light'?'light':'dark';
  $('theme-toggle').addEventListener('click',()=>{const next=document.body.dataset.theme==='dark'?'light':'dark';document.body.dataset.theme=next;try{localStorage.setItem('prismparcel-theme',next);}catch{}});
}
function boot(){
  initTheme();
  $$('.workspace-tab').forEach(button=>{button.addEventListener('click',()=>switchTab(button.dataset.tab));button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const current=button.dataset.tab;const other=current==='encode'?'decode':'encode';const next=event.key==='Home'?'encode':event.key==='End'?'decode':other;switchTab(next);$(`tab-${next}`).focus();});});
  $$('.choice-button').forEach(button=>button.addEventListener('click',()=>switchSource(button.dataset.source)));
  $$('.palette-card').forEach(button=>button.addEventListener('click',()=>selectPalette(button.dataset.style)));
  $('plain-text').addEventListener('input',()=>{resetPreview();$('char-count').textContent=`${[...$('plain-text').value].length.toLocaleString('zh-CN')} 字符`;});
  $('sample-button').addEventListener('click',()=>{$('plain-text').value='这个世界上的每一种颜色，都可以藏着一段尚未被读出的故事。\n\n—— 来自 PrismParcel 的一封像素来信。';$('plain-text').dispatchEvent(new Event('input'));$('plain-text').focus();});
  $('pixel-size').addEventListener('input',event=>{resetPreview();$('pixel-size-value').textContent=`${event.target.value}×`;});
  $('encryption-switch').addEventListener('change',event=>{resetPreview();$('encrypt-password-wrap').hidden=!event.target.checked;});
  $$('[data-reveal]').forEach(button=>button.addEventListener('click',()=>{const input=$(button.dataset.reveal);input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'显示':'隐藏';}));
  attachDropzone('file-dropzone','source-file',file=>{resetPreview();state.sourceFile=file;$('source-file-title').textContent=file?file.name:'将文件拖到这里';$('source-file-meta').textContent=file?`${formatBytes(file.size)} · ${file.type||'二进制文件'}`:'或点击选择文件 · 当前上限约 12 MiB';});
  attachDropzone('image-dropzone','image-file',file=>{state.imageFile=file;state.recovered=null;$('decode-placeholder').hidden=false;$('decode-result').hidden=true;$('restore-state').textContent='等待解封';$('image-file-title').textContent=file?file.name:'把像素图片放进来';$('image-file-meta').textContent=file?`${formatBytes(file.size)} · 待验证`:'拖放或点击选择 PNG 图片';});
  $('encrypt-password').addEventListener('input',resetPreview);
  $('compression-switch').addEventListener('change',resetPreview);
  $('generate-button').addEventListener('click',generate);$('restore-button').addEventListener('click',restore);
  $('download-button').addEventListener('click',()=>{if(state.previewBlob)downloadBlob(state.previewBlob,'PrismParcel.png');});
  $('reset-preview').addEventListener('click',resetPreview);
  $('recovered-download').addEventListener('click',()=>{const item=state.recovered;if(!item)return;const isText=item.kind==='text';downloadBlob(new Blob([item.bytes],{type:isText?'text/plain;charset=utf-8':item.mime||'application/octet-stream'}),isText?'PrismParcel-recovered.txt':item.filename||'PrismParcel-recovered.bin');});
  $('copy-text').addEventListener('click',async()=>{if(state.recovered?.kind!=='text')return;try{await navigator.clipboard.writeText($('recovered-text').value);toast('文字已复制到剪贴板。');}catch{toast('复制失败。你仍可以手动选择文本复制。',true);}});
}
boot();
