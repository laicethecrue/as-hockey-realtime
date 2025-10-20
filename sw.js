const CACHE_NAME = "as-hockey-v300";
const APP_SHELL = [
  "./","./index.html","./styles.css","./app.js","./manifest.webmanifest"
];
const DATA_URLS = ["/data.json","/cards.json"];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>k!==CACHE_NAME&&caches.delete(k)))));
  self.clients.claim();
});
function isData(req){
  try{ const u=new URL(req.url); return req.method==="GET" && u.origin===location.origin && DATA_URLS.some(p=>u.pathname.endsWith(p)); }
  catch{ return false; }
}
self.addEventListener("fetch", e=>{
  const r=e.request; if(r.method!=="GET") return;
  const u=new URL(r.url); if(u.origin!==location.origin) return;

  if(isData(r)){
    e.respondWith((async()=>{
      try{
        const fresh=await fetch(r,{cache:"no-store"});
        const cache=await caches.open(CACHE_NAME); cache.put(r,fresh.clone());
        return fresh;
      }catch{
        const cached=await caches.match(r); return cached || new Response(JSON.stringify({error:"offline"}),{status:503,headers:{"Content-Type":"application/json"}});
      }
    })());
    return;
  }

  if (r.mode==="navigate" || r.destination==="document"){
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      const cached=await cache.match("./index.html"); if(cached) return cached;
      const fresh=await fetch("./index.html"); cache.put("./index.html", fresh.clone()); return fresh;
    })());
    return;
  }

  e.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(r);
    const fetchP=fetch(r).then(resp=>{
      if(resp && resp.status===200 && resp.type==="basic"){ cache.put(r,resp.clone()); }
      return resp;
    }).catch(()=>null);
    return cached || fetchP || new Response("Offline",{status:503});
  })());
});
