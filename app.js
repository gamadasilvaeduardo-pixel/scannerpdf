/* ScanPDF — processamento integralmente local; nenhuma requisição de upload. */
'use strict';
const $ = (id) => document.getElementById(id);
const sleepFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
const state = { pages: [], selectedId: null, mode: 'crop', db: null, busy: false, previewUrl: null, imageReady: false, toastTimer: null, installPrompt: null };
const MAX_PAGES = 60;
const OUTPUT_SIZE = { compact: 1050, standard: 1600, high: 2250 };
const DEFAULT_POINTS = () => [{x:.065,y:.065},{x:.935,y:.065},{x:.935,y:.935},{x:.065,y:.935}];
const clamp = (x,min,max) => Math.max(min,Math.min(max,x));
const selectedPage = () => state.pages.find(p=>p.id===state.selectedId);
const pct = n => `${(n*100).toFixed(2)}%`;
const defer = () => new Promise(resolve => setTimeout(resolve, 10));
const supported = f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(f.name));

function toast(message, error=false) {
  const el=$('toast'); el.textContent=message; el.classList.toggle('error',error); el.classList.add('visible');
  clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove('visible'),3900);
}
function showProgress(title,detail='',progress=0){
  $('progress-title').textContent=title;$('progress-detail').textContent=detail;
  $('progress-bar').style.width=pct(progress);$('progress-overlay').classList.remove('hidden');
}
function hideProgress(){ $('progress-overlay').classList.add('hidden'); }
function updateConnectivity(){
  let online=navigator.onLine; const el=$('online-status');
  el.classList.toggle('offline',!online);
  el.innerHTML=`<span class="status-dot"></span>${online?'Pronto para uso offline':'Modo offline'}`;
}
function requestImageInput(type){ if(state.busy)return; $(type==='camera'?'camera-input':'gallery-input').click(); }

function openDB(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window))return reject(new Error('IndexedDB indisponível'));
    const r=indexedDB.open('scanpdf-documents',1);
    r.onupgradeneeded=()=>{ const db=r.result; if(!db.objectStoreNames.contains('pages'))db.createObjectStore('pages',{keyPath:'id'}); };
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
function dbAction(operation,value){
  if(!state.db)return Promise.resolve(null);
  return new Promise((resolve,reject)=>{
    try {
      const tx=state.db.transaction('pages',operation==='getAll'?'readonly':'readwrite');
      const store=tx.objectStore('pages');
      const req=operation==='getAll'?store.getAll():operation==='delete'?store.delete(value):operation==='clear'?store.clear():store.put(value);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    }catch(err){reject(err)}
  });
}
const persistenceWarning=()=>toast('Não foi possível salvar o rascunho. Exporte seu PDF antes de sair.',true);
async function savePage(p){try{await dbAction('put',{id:p.id,name:p.name,blob:p.blob,thumb:p.thumb,points:p.points,filter:p.filter,created:p.created,order:state.pages.indexOf(p)})}catch(e){console.warn('Falha ao salvar',e);persistenceWarning()}}
async function saveOrder(){ await Promise.all(state.pages.map(p=>savePage(p))); }

async function loadImage(blob){
  const url=URL.createObjectURL(blob);
  try{
    const img=new Image();img.decoding='async';img.src=url;
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Imagem não suportada neste navegador'));});
    if(!img.naturalWidth||!img.naturalHeight)throw new Error('Imagem inválida');
    return img;
  }catch(e){URL.revokeObjectURL(url);throw e}
  finally{ /* O objeto Image mantém o recurso decodificado; a URL é revogada após o carregamento. */ }
}
async function withImage(blob,callback){
  const url=URL.createObjectURL(blob);const img=new Image();img.decoding='async';
  try{
    await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('Não foi possível abrir esta imagem'));img.src=url;});
    return await callback(img);
  }finally{URL.revokeObjectURL(url);img.src='';}
}
function canvasToBlob(canvas,type='image/jpeg',quality=.88){
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Não foi possível codificar a imagem')),type,quality));
}
async function normalizeFile(file){
  return withImage(file,async img=>{
    const scale=Math.min(1,2550/Math.max(img.naturalWidth,img.naturalHeight));
    const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const ctx=c.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
    const blob=await canvasToBlob(c,'image/jpeg',.89);
    const t=document.createElement('canvas');t.width=90;t.height=115;
    const tc=t.getContext('2d');tc.fillStyle='white';tc.fillRect(0,0,90,115);
    const scaleT=Math.min(90/w,115/h);tc.drawImage(c,(90-w*scaleT)/2,(115-h*scaleT)/2,w*scaleT,h*scaleT);
    const thumb=t.toDataURL('image/jpeg',.67);
    return {blob,thumb,width:w,height:h,points:detectDocument(c)};
  });
}

// Detecção local por contraste entre o centro do documento e as bordas da fotografia.
// Em fundos semelhantes à folha, o usuário pode ajustar os quatro pontos manualmente.
function detectDocument(canvas){
  const d=document.createElement('canvas');
  const sc=Math.min(1,330/Math.max(canvas.width,canvas.height));
  d.width=Math.round(canvas.width*sc);d.height=Math.round(canvas.height*sc);
  const ctx=d.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0,d.width,d.height);
  const w=d.width,h=d.height, pixels=ctx.getImageData(0,0,w,h).data;
  const lum=new Uint8Array(w*h);
  for(let i=0,j=0;i<lum.length;i++,j+=4)lum[i]=(pixels[j]*77+pixels[j+1]*150+pixels[j+2]*29)>>8;
  const mean=(x0,y0,x1,y1)=>{
    let sum=0,n=0;
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){sum+=lum[y*w+x];n++;}
    return sum/Math.max(n,1);
  };
  const padX=Math.max(3,Math.round(w*.07)),padY=Math.max(3,Math.round(h*.07));
  const bg=(mean(0,0,padX,padY)+mean(w-padX,0,w,padY)+mean(0,h-padY,padX,h)+mean(w-padX,h-padY,w,h))/4;
  const center=mean(Math.floor(w*.38),Math.floor(h*.38),Math.floor(w*.62),Math.floor(h*.62));
  if(Math.abs(center-bg)<29)return DEFAULT_POINTS();
  const isLight=center>bg, threshold=(center+bg)*.5;
  const mask=new Uint8Array(w*h);
  for(let i=0;i<lum.length;i++)mask[i]=isLight?(lum[i]>threshold?1:0):(lum[i]<threshold?1:0);
  // Procura uma região conectada próxima ao centro da fotografia.
  let seed=-1, highest=-1;
  for(let y=Math.floor(h*.43);y<Math.floor(h*.57);y++)for(let x=Math.floor(w*.43);x<Math.floor(w*.57);x++){
    const idx=y*w+x,score=isLight?lum[idx]:255-lum[idx];
    if(mask[idx]&&score>highest){highest=score;seed=idx;}
  }
  if(seed<0)return DEFAULT_POINTS();
  const seen=new Uint8Array(w*h),stack=new Int32Array(w*h);let tail=0;
  stack[tail++]=seed;seen[seed]=1;
  let count=0;let tl={x:w,y:h,v:Infinity},tr={x:0,y:h,v:-Infinity},br={x:0,y:0,v:-Infinity},bl={x:w,y:0,v:Infinity};
  let minX=w,maxX=0,minY=h,maxY=0;
  while(tail){
    const i=stack[--tail];const x=i%w,y=Math.floor(i/w);count++;
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    const u=x+y,v=x-y;
    if(u<tl.v)tl={x,y,v:u};if(u>br.v)br={x,y,v:u};
    if(v>tr.v)tr={x,y,v};if(v<bl.v)bl={x,y,v};
    if(x>0&&mask[i-1]&&!seen[i-1]){seen[i-1]=1;stack[tail++]=i-1}
    if(x+1<w&&mask[i+1]&&!seen[i+1]){seen[i+1]=1;stack[tail++]=i+1}
    if(y>0&&mask[i-w]&&!seen[i-w]){seen[i-w]=1;stack[tail++]=i-w}
    if(y+1<h&&mask[i+w]&&!seen[i+w]){seen[i+w]=1;stack[tail++]=i+w}
  }
  const ratio=count/(w*h),bw=(maxX-minX)/w,bh=(maxY-minY)/h;
  if(ratio<.13||ratio>.93||bw<.25||bh<.25)return DEFAULT_POINTS();
  const centerX=(tl.x+tr.x+br.x+bl.x)/4, centerY=(tl.y+tr.y+br.y+bl.y)/4;
  const pts=[tl,tr,br,bl].map(p=>({x:clamp((centerX+(p.x-centerX)*1.025)/w,.018,.982),y:clamp((centerY+(p.y-centerY)*1.025)/h,.018,.982)}));
  const area=Math.abs(pts.reduce((acc,p,i)=>{const n=pts[(i+1)%4];return acc+p.x*n.y-n.x*p.y},0))/2;
  if(area<.12)return DEFAULT_POINTS();
  return pts;
}

async function addFiles(files){
  if(state.busy)return;
  const valid=Array.from(files).filter(supported);
  if(!valid.length){toast('Selecione imagens compatíveis com o navegador.',true);return}
  const allowed=MAX_PAGES-state.pages.length;
  if(allowed<=0){toast(`O limite é ${MAX_PAGES} páginas por documento.`,true);return}
  if(valid.length>allowed)toast(`Apenas ${allowed} imagens serão adicionadas (limite de ${MAX_PAGES}).`,true);
  state.busy=true;let errors=0;let lastId=null;
  try{
    const chosen=valid.slice(0,allowed);
    for(let i=0;i<chosen.length;i++){
      showProgress('Importando imagens',`${i+1} de ${chosen.length}: ${chosen[i].name}`,i/chosen.length);
      await sleepFrame();
      try{
        const norm=await normalizeFile(chosen[i]);
        const page={id:(crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`),name:chosen[i].name,blob:norm.blob,thumb:norm.thumb,points:norm.points,filter:'enhance',created:Date.now()+i, url:null};
        state.pages.push(page);await savePage(page);lastId=page.id;
      }catch(e){console.warn(e);errors++}
    }
  }finally{
    state.busy=false;hideProgress();renderPageList();
    if(lastId)selectPage(lastId);
    toast(errors?`${valid.length-errors} imagens adicionadas; ${errors} não puderam ser abertas.`:`${Math.min(valid.length,allowed)} página(s) adicionada(s).`,errors>0);
  }
}

function renderPageList(){
  $('pages-count').textContent=state.pages.length;
  $('document-total').textContent=`${state.pages.length} ${state.pages.length===1?'página':'páginas'}`;
  $('pages-empty').classList.toggle('hidden',state.pages.length>0);
  $('clear-btn').disabled=state.pages.length===0;
  $('export-btn').disabled=state.pages.length===0||state.busy;
  $('export-hint').textContent=state.pages.length?`${state.pages.length} página(s) pronta(s) para exportar.`:'Adicione pelo menos uma página para exportar.';
  const list=$('pages-list');list.replaceChildren();
  state.pages.forEach((p,i)=>{
    const node=document.createElement('div');node.className='page-item'+(p.id===state.selectedId?' selected':'');node.tabIndex=0;
    node.setAttribute('role','button');node.setAttribute('aria-label',`Selecionar página ${i+1}`);
    const thumb=document.createElement('img');thumb.className='page-thumbnail';thumb.src=p.thumb;thumb.alt='';
    const meta=document.createElement('div');meta.className='page-item-meta';
    const title=document.createElement('strong');title.textContent=`Página ${i+1}`;
    const name=document.createElement('span');name.title=p.name;name.textContent=p.name;
    const actions=document.createElement('div');actions.className='page-item-actions';
    const buttons=[['↑','Mover para cima',()=>movePage(i,-1)],['↓','Mover para baixo',()=>movePage(i,1)],['×','Remover página',()=>removePage(p.id)]];
    buttons.forEach(([symbol,label,fn],j)=>{const b=document.createElement('button');b.textContent=symbol;b.type='button';b.title=label;b.setAttribute('aria-label',label);if(j===2)b.classList.add('danger');if((j===0&&i===0)||(j===1&&i===state.pages.length-1))b.disabled=true;b.addEventListener('click',e=>{e.stopPropagation();fn()});actions.append(b)});
    meta.append(title,name,actions);node.append(thumb,meta);
    node.addEventListener('click',()=>selectPage(p.id));node.addEventListener('keydown',e=>{if(e.target===node&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectPage(p.id)}});list.append(node);
  });
}
async function movePage(i,delta){
  const j=i+delta;if(j<0||j>=state.pages.length||state.busy)return;
  [state.pages[i],state.pages[j]]=[state.pages[j],state.pages[i]];renderPageList();try{await saveOrder()}catch(e){console.warn(e)}
}
async function removePage(id){
  if(state.busy)return;const idx=state.pages.findIndex(p=>p.id===id);if(idx<0)return;
  const [p]=state.pages.splice(idx,1);if(p.url)URL.revokeObjectURL(p.url);
  try{await dbAction('delete',id)}catch(e){persistenceWarning()}
  if(id===state.selectedId){state.selectedId=null;if(state.pages.length)selectPage(state.pages[Math.min(idx,state.pages.length-1)].id);else{clearPreview();renderEditor()}}
  renderPageList();await saveOrder();
}
async function clearPages(){
  if(!state.pages.length||state.busy||!confirm('Excluir todas as páginas deste rascunho?'))return;
  state.pages.forEach(p=>{if(p.url)URL.revokeObjectURL(p.url)});state.pages=[];state.selectedId=null;clearPreview();
  try{await dbAction('clear')}catch(e){persistenceWarning()}
  renderPageList();renderEditor();toast('Páginas removidas.');
}
function clearPreview(){if(state.previewUrl){URL.revokeObjectURL(state.previewUrl);state.previewUrl=null}}
function selectPage(id){
  if(state.busy&&state.selectedId)return;
  const p=state.pages.find(x=>x.id===id);if(!p)return;
  state.selectedId=id;state.mode='crop';clearPreview();renderPageList();renderEditor();
}
function renderEditor(){
  const p=selectedPage();$('empty-state').classList.toggle('hidden',!!p);$('editor-content').classList.toggle('hidden',!p);
  $('editor-tools').classList.toggle('hidden',!p);$('editor-title').textContent=p?`Página ${state.pages.indexOf(p)+1}`:'Pré-visualização';
  if(!p)return;
  if(!p.url)p.url=URL.createObjectURL(p.blob);
  const img=$('source-image');state.imageReady=false;
  const onReady=()=>{if(state.selectedId!==p.id)return;state.imageReady=true;fitSurface(img.naturalWidth,img.naturalHeight);updateCropOverlay();$('page-dimensions').textContent=`${img.naturalWidth} × ${img.naturalHeight} px`};
  img.onload=onReady;img.src=p.url;
  if(img.complete&&img.naturalWidth)onReady();
  refreshMode();refreshFilters();
}
function fitSurface(w,h){
  const maxW=Math.min(680,Math.floor(466*w/h));
  const surface=$('page-surface');
  surface.style.width=`min(100%, ${maxW}px)`;
  surface.style.aspectRatio=`${w}/${h}`;
}
function refreshMode(){
  const preview=state.mode==='result';
  $('mode-crop').classList.toggle('active',!preview);$('mode-result').classList.toggle('active',preview);
  $('mode-crop').setAttribute('aria-pressed',String(!preview));$('mode-result').setAttribute('aria-pressed',String(preview));
  $('crop-svg').classList.toggle('hidden',preview);$('crop-handles').classList.toggle('hidden',preview);
  $('processed-image').classList.toggle('hidden',!preview);
  $('editor-guidance').textContent=preview?'Prévia do PDF com o filtro selecionado.':'Arraste os pontos verdes para ajustar o recorte.';
}
function refreshFilters(){const p=selectedPage();if(!p)return;document.querySelectorAll('.filter-chip').forEach(b=>{const a=b.dataset.filter===p.filter;b.classList.toggle('active',a);b.setAttribute('aria-pressed',String(a))})}
function updateCropOverlay(){
  const p=selectedPage();if(!p)return;
  const pts=p.points.map(o=>`${Math.round(o.x*1000)},${Math.round(o.y*1000)}`);
  $('crop-line').setAttribute('points',pts.join(' '));
  $('crop-shade').setAttribute('d',`M0 0H1000V1000H0Z M${pts.join(' L')} Z`);
  document.querySelectorAll('.crop-handle').forEach(b=>{const pt=p.points[Number(b.dataset.corner)];b.style.left=pct(pt.x);b.style.top=pct(pt.y)});
}
function setupDragging(){
  document.querySelectorAll('.crop-handle').forEach(b=>{
    let dragging=false;const index=Number(b.dataset.corner);
    b.addEventListener('pointerdown',e=>{if(state.busy)return;e.preventDefault();dragging=true;b.setPointerCapture(e.pointerId)});
    b.addEventListener('pointermove',e=>{
      if(!dragging||!selectedPage())return;e.preventDefault();
      const r=$('page-surface').getBoundingClientRect(),p=selectedPage(),points=p.points;
      let x=clamp((e.clientX-r.left)/r.width,.01,.99),y=clamp((e.clientY-r.top)/r.height,.01,.99);
      if(index===0){x=Math.min(x,points[1].x-.08);y=Math.min(y,points[3].y-.08)}
      if(index===1){x=Math.max(x,points[0].x+.08);y=Math.min(y,points[2].y-.08)}
      if(index===2){x=Math.max(x,points[3].x+.08);y=Math.max(y,points[1].y+.08)}
      if(index===3){x=Math.min(x,points[2].x-.08);y=Math.max(y,points[0].y+.08)}
      points[index]={x:clamp(x,.01,.99),y:clamp(y,.01,.99)};updateCropOverlay();
    });
    const end=()=>{if(dragging){dragging=false;if(selectedPage())savePage(selectedPage())}};
    b.addEventListener('pointerup',end);b.addEventListener('pointercancel',end);b.addEventListener('lostpointercapture',end);
  });
}
async function applyDetect(){
  const p=selectedPage();if(!p||state.busy)return;
  p.points=await withImage(p.blob,img=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);return detectDocument(c)});
  updateCropOverlay();await savePage(p);toast('Bordas recalculadas. Ajuste os cantos se necessário.');
}
async function resetCrop(){const p=selectedPage();if(!p)return;p.points=DEFAULT_POINTS();updateCropOverlay();await savePage(p)}
async function rotatePage(){
  const p=selectedPage();if(!p||state.busy)return;
  state.busy=true;showProgress('Girando página','Aplicando rotação de 90°...');
  try{
    const out=await withImage(p.blob,async img=>{
      const c=document.createElement('canvas');c.width=img.naturalHeight;c.height=img.naturalWidth;
      const ctx=c.getContext('2d',{alpha:false});ctx.translate(c.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(img,0,0);
      const blob=await canvasToBlob(c,'image/jpeg',.91);
      const t=document.createElement('canvas');t.width=90;t.height=115;const tc=t.getContext('2d');tc.fillStyle='#fff';tc.fillRect(0,0,90,115);const s=Math.min(90/c.width,115/c.height);tc.drawImage(c,(90-c.width*s)/2,(115-c.height*s)/2,c.width*s,c.height*s);
      return {blob,thumb:t.toDataURL('image/jpeg',.7)};
    });
    if(p.url)URL.revokeObjectURL(p.url);p.url=null;p.blob=out.blob;p.thumb=out.thumb;
    const old=p.points; // Correspondência dos pontos ao girar 90° no sentido horário.
    p.points=[{x:1-old[3].y,y:old[3].x},{x:1-old[0].y,y:old[0].x},{x:1-old[1].y,y:old[1].x},{x:1-old[2].y,y:old[2].x}];
    state.mode='crop';clearPreview();await savePage(p);
  }catch(e){console.error(e);toast('Não foi possível girar a página.',true)}
  finally{state.busy=false;hideProgress();renderPageList();renderEditor()}
}

function homography(src){
  const [a,b,c,d]=src;
  const dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x;
  const dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y;
  let g=0,h=0;const den=dx1*dy2-dx2*dy1;
  if(Math.abs(den)>1e-9){g=(dx3*dy2-dx2*dy3)/den;h=(dx1*dy3-dx3*dy1)/den}
  return {a:b.x-a.x+g*b.x,b:d.x-a.x+h*d.x,c:a.x,d:b.y-a.y+g*b.y,e:d.y-a.y+h*d.y,f:a.y,g,h};
}
function metricDist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
async function processPage(p,maxLong=1600,jpegQ=.85){
  return withImage(p.blob,async img=>{
    const w=img.naturalWidth,h=img.naturalHeight;
    const pts=p.points.map(pt=>({x:pt.x*w,y:pt.y*h}));
    let destW=(metricDist(pts[0],pts[1])+metricDist(pts[3],pts[2]))/2;
    let destH=(metricDist(pts[0],pts[3])+metricDist(pts[1],pts[2]))/2;
    const sc=Math.min(1,maxLong/Math.max(destW,destH));destW=Math.max(80,Math.round(destW*sc));destH=Math.max(80,Math.round(destH*sc));
    const source=document.createElement('canvas');source.width=w;source.height=h;
    const sctx=source.getContext('2d',{willReadFrequently:true,alpha:false});sctx.drawImage(img,0,0);
    const original=sctx.getImageData(0,0,w,h).data;
    const out=document.createElement('canvas');out.width=destW;out.height=destH;
    const dctx=out.getContext('2d',{alpha:false});const id=dctx.createImageData(destW,destH);const dest=id.data;
    const m=homography(pts);let k=0;
    for(let y=0;y<destH;y++){
      const v=(y+.5)/destH, bv=m.b*v+m.c,ev=m.e*v+m.f,hv=m.h*v+1;
      for(let x=0;x<destW;x++){
        const u=(x+.5)/destW,den=m.g*u+hv;
        const fx=clamp((m.a*u+bv)/den,0,w-1.001),fy=clamp((m.d*u+ev)/den,0,h-1.001);
        const ix=fx|0,iy=fy|0,dx=fx-ix,dy=fy-iy;
        const idx=(iy*w+ix)*4, idxR=idx+4,idxB=idx+w*4,idxBR=idxB+4;
        for(let ch=0;ch<3;ch++){
          const t=original[idx+ch]*(1-dx)+original[idxR+ch]*dx;
          const b=original[idxB+ch]*(1-dx)+original[idxBR+ch]*dx;
          dest[k+ch]=t*(1-dy)+b*dy;
        }
        dest[k+3]=255;k+=4;
      }
    }
    applyFilter(dest,destW,destH,p.filter);
    dctx.putImageData(id,0,0);
    const blob=await canvasToBlob(out,'image/jpeg',jpegQ);
    return {blob,width:destW,height:destH};
  });
}
function applyFilter(data,w,h,filter){
  if(filter==='color')return;
  if(filter==='enhance'){
    for(let i=0;i<data.length;i+=4){for(let j=0;j<3;j++)data[i+j]=clamp((data[i+j]-128)*1.14+136,0,255)}
    return;
  }
  const gray=new Uint8Array(w*h);
  for(let i=0,j=0;i<gray.length;i++,j+=4)gray[i]=(data[j]*77+data[j+1]*150+data[j+2]*29)>>8;
  if(filter==='gray'){
    for(let i=0,j=0;i<gray.length;i++,j+=4)data[j]=data[j+1]=data[j+2]=gray[i];return;
  }
  // Limiar adaptativo: funciona melhor do que um limiar global com sombras suaves.
  const stride=w+1,integral=new Float64Array((w+1)*(h+1));
  for(let y=1;y<=h;y++){
    let rowSum=0;for(let x=1;x<=w;x++){rowSum+=gray[(y-1)*w+x-1];integral[y*stride+x]=integral[(y-1)*stride+x]+rowSum}
  }
  const radius=Math.max(8,Math.round(Math.min(w,h)/65));
  for(let y=0;y<h;y++){
    const y0=Math.max(0,y-radius),y1=Math.min(h,y+radius+1);
    for(let x=0;x<w;x++){
      const x0=Math.max(0,x-radius),x1=Math.min(w,x+radius+1);
      const sum=integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0];
      const avg=sum/((y1-y0)*(x1-x0));
      const v=gray[y*w+x]>=avg-12?255:0,i=(y*w+x)*4;data[i]=data[i+1]=data[i+2]=v;
    }
  }
}
async function showResult(){
  const p=selectedPage();if(!p||state.busy)return;
  state.busy=true;showProgress('Preparando prévia','Aplicando recorte e filtro...');await defer();
  try{
    const res=await processPage(p,1000,.79);
    clearPreview();state.previewUrl=URL.createObjectURL(res.blob);
    $('processed-image').src=state.previewUrl;state.mode='result';fitSurface(res.width,res.height);refreshMode();
  }catch(e){console.error(e);toast('Não foi possível processar a imagem.',true)}
  finally{state.busy=false;hideProgress()}
}
function showCrop(){state.mode='crop';clearPreview();refreshMode();const img=$('source-image');if(img.naturalWidth)fitSurface(img.naturalWidth,img.naturalHeight);updateCropOverlay()}

function encode(str){return new TextEncoder().encode(str)}
async function makePdf(images,paperChoice){
  const chunks=[];let size=0;const offsets=[];
  const push=(part)=>{const bytes=typeof part==='string'?encode(part):part;chunks.push(bytes);size+=bytes.length};
  const obj=(id,fn)=>{offsets[id]=size;push(`${id} 0 obj\n`);fn();push('endobj\n')};
  const count=images.length;
  push(new Uint8Array([37,80,68,70,45,49,46,52,10,37,226,227,207,211,10]));
  obj(1,()=>push('<< /Type /Catalog /Pages 2 0 R >>\n'));
  obj(2,()=>push(`<< /Type /Pages /Count ${count} /Kids [${images.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] >>\n`));
  for(let i=0;i<count;i++){
    const item=images[i],pId=3+i*3,imgId=pId+1,contentId=pId+2;
    const portrait=paperChoice==='portrait'||(paperChoice==='auto'&&item.height>=item.width);
    const W=portrait?595.28:841.89,H=portrait?841.89:595.28;
    const margin=14,ratio=Math.min((W-margin*2)/item.width,(H-margin*2)/item.height);
    const drawW=item.width*ratio,drawH=item.height*ratio,x=(W-drawW)/2,y=(H-drawH)/2;
    const bytes=new Uint8Array(await item.blob.arrayBuffer());
    const content=encode(`q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`);
    obj(pId,()=>push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>\n`));
    obj(imgId,()=>{push(`<< /Type /XObject /Subtype /Image /Width ${item.width} /Height ${item.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);push(bytes);push('\nendstream\n')});
    obj(contentId,()=>{push(`<< /Length ${content.length} >>\nstream\n`);push(content);push('endstream\n')});
  }
  const xrefOffset=size,totalObjects=2+3*count;
  push(`xref\n0 ${totalObjects+1}\n0000000000 65535 f \n`);
  for(let id=1;id<=totalObjects;id++)push(`${String(offsets[id]).padStart(10,'0')} 00000 n \n`);
  push(`trailer\n<< /Size ${totalObjects+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Blob(chunks,{type:'application/pdf'});
}
async function exportPdf(){
  if(!state.pages.length||state.busy)return;
  state.busy=true;$('export-btn').disabled=true;
  const quality=$('quality').value,maxLong=OUTPUT_SIZE[quality];
  const done=[];
  try{
    for(let i=0;i<state.pages.length;i++){
      showProgress('Gerando seu PDF',`Processando página ${i+1} de ${state.pages.length}`,i/state.pages.length);
      await sleepFrame();done.push(await processPage(state.pages[i],maxLong,quality==='high'?.94:quality==='compact'?.72:.86));
    }
    showProgress('Gerando seu PDF','Finalizando arquivo...',.97);await sleepFrame();
    const pdf=await makePdf(done,$('paper-size').value);
    const dt=new Date(),pad=n=>String(n).padStart(2,'0');
    const filename=`digitalizacao-${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}_${pad(dt.getHours())}-${pad(dt.getMinutes())}.pdf`;
    const url=URL.createObjectURL(pdf);const link=document.createElement('a');link.href=url;link.download=filename;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    toast(`PDF com ${done.length} página(s) gerado: ${(pdf.size/1024/1024).toFixed(2)} MB`);
  }catch(e){console.error('Falha na exportação',e);toast(`Falha ao gerar PDF: ${e.message||'erro inesperado'}`,true)}
  finally{state.busy=false;hideProgress();renderPageList()}
}
async function setupPersistence(){
  try{
    state.db=await openDB();let saved=await dbAction('getAll');saved.sort((a,b)=>(a.order??a.created)-(b.order??b.created));
    state.pages=saved.map(p=>({...p,url:null,points:p.points||DEFAULT_POINTS(),filter:p.filter||'enhance'}));
    if(state.pages.length)state.selectedId=state.pages[0].id;
    renderPageList();renderEditor();
  }catch(e){console.warn('IndexedDB indisponível:',e);toast('Armazenamento local indisponível: exporte antes de fechar.',true)}
}
function setupInstall(){
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.installPrompt=event;$('install-btn').classList.remove('hidden')});
  $('install-btn').addEventListener('click',async()=>{
    if(state.installPrompt){state.installPrompt.prompt();await state.installPrompt.userChoice;state.installPrompt=null;$('install-btn').classList.add('hidden')}
    else toast('No navegador: escolha "Adicionar à tela inicial" no menu de compartilhar.');
  });
  if(/iPhone|iPad|iPod/i.test(navigator.userAgent)&&!window.navigator.standalone){$('install-btn').classList.remove('hidden')}
  window.addEventListener('appinstalled',()=>{$('install-btn').classList.add('hidden');toast('Scanner instalado!')});
}
function setupDrop(){
  let dragCount=0;
  window.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();dragCount++;document.body.classList.add('drag-over')}});
  window.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault()});
  window.addEventListener('dragleave',e=>{if(e.dataTransfer?.types?.includes('Files')){dragCount--;if(dragCount<=0){dragCount=0;document.body.classList.remove('drag-over')}}});
  window.addEventListener('drop',e=>{e.preventDefault();dragCount=0;document.body.classList.remove('drag-over');if(e.dataTransfer?.files?.length)addFiles(e.dataTransfer.files)});
  document.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])].filter(supported);if(files.length)addFiles(files)});
}
async function main(){
  updateConnectivity();window.addEventListener('online',updateConnectivity);window.addEventListener('offline',updateConnectivity);
  $('camera-btn').addEventListener('click',()=>requestImageInput('camera'));
  $('gallery-btn').addEventListener('click',()=>requestImageInput('gallery'));
  $('add-page-btn').addEventListener('click',()=>requestImageInput('gallery'));
  $('empty-add').addEventListener('click',e=>{e.stopPropagation();requestImageInput('gallery')});
  $('empty-state').addEventListener('click',()=>requestImageInput('gallery'));
  $('empty-state').addEventListener('keydown',e=>{if(e.target===$('empty-state')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();requestImageInput('gallery')}});
  for(const id of ['camera-input','gallery-input'])$(id).addEventListener('change',async e=>{const files=[...e.target.files];e.target.value='';await addFiles(files)});
  $('clear-btn').addEventListener('click',clearPages);
  $('mode-crop').addEventListener('click',showCrop);
  $('mode-result').addEventListener('click',showResult);
  $('detect-btn').addEventListener('click',applyDetect);
  $('reset-btn').addEventListener('click',resetCrop);
  $('rotate-btn').addEventListener('click',rotatePage);
  $('export-btn').addEventListener('click',exportPdf);
  document.querySelectorAll('.filter-chip').forEach(b=>b.addEventListener('click',async()=>{
    const p=selectedPage();if(!p||state.busy)return;p.filter=b.dataset.filter;refreshFilters();await savePage(p);if(state.mode==='result')showResult();
  }));
  setupDragging();setupDrop();setupInstall();await setupPersistence();
  if('serviceWorker' in navigator&&location.protocol!=='file:'){
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Falha ao ativar o modo offline',err));
  }
}
main();
