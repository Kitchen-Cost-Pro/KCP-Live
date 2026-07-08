const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/index-Blux3OtK.js","assets/_commonjsHelpers-Cpj98o6Y.js"])))=>i.map(i=>d[i]);
import{_ as q}from"./index-DorergQM.js";let n=null,h=!1;function k(e){if(e)return["QR_CODE","CODE_39","CODE_93","CODE_128","EAN_13","EAN_8","UPC_A","UPC_E","ITF","CODABAR","DATA_MATRIX","PDF_417"].map(r=>e[r]).filter(r=>typeof r=="number")}async function B({elementId:e,continuous:r=!1,continuousIntervalMs:l=1e3,useQrbox:p=!0,onScan:s,onStatus:c,onError:t}={}){const y=new Map,o=document.getElementById(e);if(!o){const d=new Error("Scanner container is not available yet.");return t==null||t(d),null}try{const{Html5Qrcode:d,Html5QrcodeSupportedFormats:x}=await q(async()=>{const{Html5Qrcode:u,Html5QrcodeSupportedFormats:i}=await import("./index-Blux3OtK.js");return{Html5Qrcode:u,Html5QrcodeSupportedFormats:i}},__vite__mapDeps([0,1])),m=k(x);n=new d(e,m!=null&&m.length?{formatsToSupport:m}:void 0);const _=Math.min(Math.round(((o==null?void 0:o.clientWidth)||320)*.72),280),a=p?{fps:10,qrbox:{width:_,height:_}}:{fps:10},b=u=>{if(h)return;const i=String(u||"").trim();if(!i)return;c==null||c(`Detected ${i}`);const C=f=>f===!1?!1:f&&typeof f=="object"&&"beep"in f?f.beep!==!1:!0;if(r){const f=Date.now(),D=y.get(i)||0;if(f-D<Math.max(Number(l||1e3),250))return;y.set(i,f);const M=s==null?void 0:s(i,{continuous:!0});C(M)&&E(),c==null||c(`Counted ${i} (+1)`);return}const g=s==null?void 0:s(i,{continuous:!1});C(g)&&E()},v=()=>{h||c==null||c("Scanning...")};let A=null;try{await n.start({facingMode:{exact:"environment"}},a,b,v)}catch(u){A=u;try{await n.start({facingMode:"environment"},a,b,v)}catch(i){A=i;try{await n.start({facingMode:"user"},a,b,v)}catch(C){A=C;const g=n;n=null;try{g==null||g.clear()}catch{}throw A}}}return async()=>{if(!n)return;const u=n;n=null,h=!0,await u.stop().catch(()=>{});try{u.clear()}catch{}finally{h=!1}}}catch(d){return n=null,t==null||t(d),null}}async function F({title:e="Scan Barcode",helper:r="Point your camera at a barcode.",onScan:l,continuous:p=!1,continuousIntervalMs:s=1e3,useQrbox:c=!0}={}){var m,_;w(),h=!1;const t=document.createElement("div");t.className="barcodeScanner",t.innerHTML=`
    <section class="barcodeScanner__modal" role="dialog" aria-modal="true" aria-labelledby="barcode-scanner-title">
      <header class="barcodeScanner__header">
        <div>
          <p>Photo Scanner</p>
          <h2 id="barcode-scanner-title">${S(e)}</h2>
          <span>${S(r)}</span>
        </div>
        <button type="button" class="barcodeScanner__close" data-scanner-close aria-label="Close scanner">${O("x")}</button>
      </header>
      <div class="barcodeScanner__viewport">
        <div id="barcode-scanner-reader" class="barcodeScanner__reader"></div>
        <div class="barcodeScanner__reticle" aria-hidden="true"></div>
        <div class="barcodeScanner__status" data-scanner-status>Starting camera...</div>
      </div>
      <form class="barcodeScanner__manual" data-scanner-form>
        <label>
          <span>Manual Barcode</span>
          <input type="text" inputmode="numeric" autocomplete="off" placeholder="Type or paste barcode..." data-scanner-manual />
        </label>
        <button type="submit">Use Code</button>
      </form>
    </section>
  `,document.body.appendChild(t),t.querySelector("#barcode-scanner-reader");const y=t.querySelector("[data-scanner-status]"),o=t.querySelector("[data-scanner-manual]"),d=(a,{closeAfter:b=!p}={})=>{const v=String(a||"").trim();if(v){if(l==null||l(v),b){w();return}o&&(o.value="")}};(m=t.querySelector("[data-scanner-close]"))==null||m.addEventListener("click",w),t.addEventListener("click",a=>{a.target===t&&w()}),(_=t.querySelector("[data-scanner-form]"))==null||_.addEventListener("submit",a=>{a.preventDefault(),d(o==null?void 0:o.value,{closeAfter:!p})});const x=await B({elementId:"barcode-scanner-reader",continuous:p,continuousIntervalMs:s,useQrbox:c,onScan:(a,{continuous:b}={})=>{d(a,{closeAfter:!b})},onStatus:a=>{y&&(y.textContent=a)},onError:a=>{console.warn("[Scanner] Camera scanner failed:",a)}});return n||(y.textContent="Camera permission denied or unavailable. Enter the barcode below.",o==null||o.focus({preventScroll:!0})),x||(async()=>{})}async function T({elementId:e,continuous:r=!1,continuousIntervalMs:l=1e3,useQrbox:p=!0,onScan:s,onStatus:c,onError:t}={}){return w(),h=!1,B({elementId:e,continuous:r,continuousIntervalMs:l,useQrbox:p,onScan:s,onStatus:c,onError:t})}function w(){if(h=!0,n){const e=n;n=null,e.stop().catch(()=>{}).finally(()=>{try{e.clear()}catch{}})}document.querySelectorAll(".barcodeScanner").forEach(e=>e.remove())}function E(){try{const e=new AudioContext,r=e.createOscillator(),l=e.createGain();r.frequency.value=880,l.gain.value=.035,r.connect(l),l.connect(e.destination),r.start(),r.stop(e.currentTime+.08)}catch{}}function O(e){return`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${{x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'}[e]}
    </svg>
  `}function S(e=""){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}export{w as closeBarcodeScanner,T as mountBarcodeScanner,F as openBarcodeScanner};
