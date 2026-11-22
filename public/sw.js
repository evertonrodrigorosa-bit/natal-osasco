self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",()=>{});
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:"window"}).then(cs=>cs.length?cs[0].focus():self.clients.openWindow("/")));});
self.addEventListener("push",e=>{let d={};try{d=e.data.json();}catch(x){d={title:"Natal Osasco",body:e.data?e.data.text():""};}
e.waitUntil(self.registration.showNotification(d.title||"Natal Osasco",{body:d.body||"",tag:d.tag,icon:"/icon-192.png",badge:"/icon-192.png",vibrate:[200,100,200],renotify:true}));});
