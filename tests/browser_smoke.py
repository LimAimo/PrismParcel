"""Optional visual / e2e smoke test (requires Python Playwright, Chromium, cryptography).
Uses a local HTML snapshot: safe for environments that restrict browser URL navigation.
A Python-backed WebCrypto shim is used only because about:blank is an insecure origin.
Real WebCrypto semantics are separately tested by Node's native WebCrypto unit suite.
"""
import asyncio, os, hashlib, tempfile, shutil
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
SHIM=r'''
const nativeCrypto=globalThis.crypto;
const shim={
  getRandomValues(array){return nativeCrypto.getRandomValues(array)},
  subtle:{
    async digest(algo,data){return Uint8Array.from(await __sha256(Array.from(new Uint8Array(data)))).buffer},
    async importKey(format,data){return {password:Array.from(new Uint8Array(data))}},
    async deriveKey(params,key){return {bytes:await __pbkdf2(key.password,Array.from(params.salt),params.iterations)}},
    async encrypt(params,key,bytes){return Uint8Array.from(await __aes(true,key.bytes,Array.from(params.iv),Array.from(new Uint8Array(bytes)))).buffer},
    async decrypt(params,key,bytes){return Uint8Array.from(await __aes(false,key.bytes,Array.from(params.iv),Array.from(new Uint8Array(bytes)))).buffer},
  }
};
Object.defineProperty(globalThis,'crypto',{value:shim,configurable:true});
'''
async def run():
    html=(ROOT/'index.html').read_text()
    css=(ROOT/'styles.css').read_text()
    codec=(ROOT/'src'/'codec.mjs').read_text()
    app=(ROOT/'src'/'app.mjs').read_text()
    html=html.replace('<link rel="stylesheet" href="styles.css">','<style>'+css+'</style>').replace('<script src="src/app.mjs" type="module"></script>','')
    module=codec+'\n'+app.replace("import {createPacket,openPacket,packetToPixels,pixelsToPacket,MAX_CANVAS_PIXELS,MAX_FRAME_BYTES,PALETTES,fitBlockSize} from './codec.mjs';",'')
    temp_dir=Path(tempfile.mkdtemp(prefix='prismparcel-e2e-'))
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path=os.getenv('PRISM_CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        for name,viewport in [('desktop',{'width':1440,'height':950}),('tablet',{'width':800,'height':1024}),('phone',{'width':390,'height':844})]:
            page=await browser.new_page(viewport=viewport,device_scale_factor=1,accept_downloads=True)
            errors=[]
            page.on('pageerror',lambda e: errors.append(str(e)))
            await page.expose_function('__sha256',lambda data:list(hashlib.sha256(bytes(data)).digest()))
            await page.expose_function('__pbkdf2',lambda password,salt,iters:list(hashlib.pbkdf2_hmac('sha256',bytes(password),bytes(salt),iters,32)))
            await page.expose_function('__aes',lambda encrypt,key,iv,data:list(AESGCM(bytes(key)).encrypt(bytes(iv),bytes(data),None) if encrypt else AESGCM(bytes(key)).decrypt(bytes(iv),bytes(data),None)))
            await page.set_content(html,wait_until='load')
            await page.add_script_tag(content=SHIM)
            await page.add_script_tag(type='module',content=module)
            await page.wait_for_function('document.querySelector("#generate-button") !== null',timeout=8000)
            dims=await page.evaluate('({viewport:innerWidth,body:document.body.scrollWidth,page:document.documentElement.scrollWidth})')
            print(name,'dimensions',dims)
            assert dims['page']<=dims['viewport']+1,'Horizontal overflow on '+name
            await page.screenshot(path=str(ROOT/'docs'/f'preview-{name}.png'),full_page=True)
            # Regression: default example, full spectrum, pixel size 8.
            await page.locator('#sample-button').click()
            await page.locator('#pixel-size').fill('8')
            await page.locator('#generate-button').click()
            await page.wait_for_function('!document.querySelector("#download-button").disabled',timeout=20000)
            assert '8×' in await page.locator('#stat-dimensions').inner_text()
            async with page.expect_download() as dense_d:
                await page.locator('#download-button').click()
            dense_png=temp_dir/f'pixel8-{name}.png'
            await (await dense_d.value).save_as(dense_png)
            assert dense_png.stat().st_size>100, 'Invalid PNG size'
            await page.locator('#tab-decode').click()
            await page.locator('#image-file').set_input_files(str(dense_png))
            await page.locator('#restore-button').click()
            await page.locator('#recovered-text').wait_for(state='visible',timeout=20000)
            assert '像素来信' in await page.locator('#recovered-text').input_value()
            assert '0.0' not in await page.locator('#image-file-meta').inner_text()
            print(name,'8× full spectrum PNG roundtrip passed',dense_png.stat().st_size)
            await page.locator('#tab-encode').click()
            await page.locator('#pixel-size').fill('3')
            await page.locator('[data-style="aurora"]').click()
            await page.locator('#encryption-switch').check()
            await page.locator('#encrypt-password').fill('password_2026')
            await page.locator('#generate-button').click()
            await page.wait_for_function('!document.querySelector("#download-button").disabled',timeout=20000)
            async with page.expect_download() as d:
                await page.locator('#download-button').click()
            png=temp_dir/f'smoke-{name}.png'
            await (await d.value).save_as(png)
            assert png.stat().st_size>100
            await page.locator('#tab-decode').click()
            await page.locator('#image-file').set_input_files(str(png))
            await page.locator('#decrypt-password').fill('password_2026')
            await page.locator('#restore-button').click()
            await page.locator('#recovered-text').wait_for(state='visible',timeout=20000)
            assert '像素来信' in await page.locator('#recovered-text').input_value()
            print(name,'PNG encrypted roundtrip passed, size',png.stat().st_size)
            await page.locator('#tab-encode').click()
            await page.locator('[data-source="file"]').click()
            original=bytes(range(256))*3
            await page.locator('#source-file').set_input_files({'name':'sample-binary.dat','mimeType':'application/octet-stream','buffer':original})
            await page.locator('#encryption-switch').uncheck()
            await page.locator('[data-style="graphite"]').click()
            await page.locator('#generate-button').click()
            await page.wait_for_function('!document.querySelector("#download-button").disabled',timeout=20000)
            async with page.expect_download() as file_d:
                await page.locator('#download-button').click()
            file_png=temp_dir/f'smoke-file-{name}.png'
            await (await file_d.value).save_as(file_png)
            await page.locator('#tab-decode').click()
            await page.locator('#image-file').set_input_files(str(file_png))
            await page.locator('#decrypt-password').fill('')
            await page.locator('#restore-button').click()
            await page.locator('#recovered-file-card').wait_for(state='visible',timeout=20000)
            async with page.expect_download() as recovered_d:
                await page.locator('#recovered-download').click()
            recovered=await recovered_d.value
            assert recovered.suggested_filename=='sample-binary.dat', recovered.suggested_filename
            destination=temp_dir/f'smoke-recovered-{name}.dat'
            await recovered.save_as(destination)
            assert destination.read_bytes()==original
            print(name,'PNG binary file roundtrip passed')
            # An extension is not proof of PNG format.
            await page.locator('#image-file').set_input_files({'name':'fake.png','mimeType':'image/png','buffer':b'not-a-valid-png-file-contents!!'})
            await page.locator('#restore-button').click()
            await page.locator('.toast.is-error').last.wait_for(timeout=8000)
            assert '请选择 PNG 图片' in await page.locator('.toast.is-error').last.inner_text()
            print(name,'invalid PNG content rejected')
            await page.locator('#tab-encode').click()
            await page.locator('[data-source="file"]').click()
            assert await page.locator('#source-file-panel').is_visible()
            await page.locator('[data-style="sunset"]').click()
            assert 'is-selected' in (await page.locator('[data-style="sunset"]').get_attribute('class'))
            await page.locator('#theme-toggle').click()
            assert await page.locator('body').get_attribute('data-theme')=='light'
            assert not errors,errors
            print(name,'UI smoke passed')
            await page.close()
        await browser.close()
    shutil.rmtree(temp_dir)
asyncio.run(run())
