/* v22: UI display preferences only; routing safety checks are unaffected. */
(()=>{'use strict';
const ids={route:'v22RouteVisible',incident:'v22IncidentVisible',risk:'v22RiskVisible'};
const key='restaurant_map_visibility_v22';
function read(){try{const x=JSON.parse(localStorage.getItem(key)||'{}');return x&&typeof x==='object'?x:{};}catch{return {};}}
function visible(k){const el=document.getElementById(ids[k]);return el?el.checked:true;}
window.v22LayerVisible=visible;
function apply(){
 window.v22RefreshRouteVisibility?.();
 window.v22RefreshIncidentVisibility?.();
 const results=document.getElementById('autoRouteResults');
 if(results)results.classList.toggle('v22-hide-risk',!visible('risk'));
}
function init(){const saved=read();for(const [k,id] of Object.entries(ids)){
 const el=document.getElementById(id);if(!el)continue;
 if(typeof saved[k]==='boolean')el.checked=saved[k];
 el.addEventListener('change',()=>{
  const next={};for(const k of Object.keys(ids))next[k]=visible(k);
  try{localStorage.setItem(key,JSON.stringify(next));}catch{}
  apply();
 });
}
apply();
const target=document.getElementById('autoRouteResults');if(target)new MutationObserver(apply).observe(target,{childList:true});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
