/* v21 rainfall/elevation flood concern screening; not real-time inundation detection. */
(() => {
'use strict';
let selectMode = false, points = [], marks = [], candidates = [], drawn = null, bound = null, lastSelected = null;
const $ = id => document.getElementById(id);
const status = s => { if ($('autoRouteStatus')) $('autoRouteStatus').textContent=s; };
function getMap(){ try { return (typeof map !== 'undefined') ? map : null; } catch { return null; } }
function connect(){const m=getMap(); if(!m || m===bound)return; bound=m; m.on('click', e=>{
  if(!selectMode)return;
  if(points.length===2){ points=[]; marks.forEach(x=>m.removeLayer(x));marks=[];clearLine(); }
  points.push([e.latlng.lat,e.latlng.lng]);
  marks.push(L.marker(e.latlng).addTo(m).bindPopup(points.length===1?'出発地':'目的地'));
  status(points.length===1?'目的地をクリックしてください。':'2点を設定しました。「経路候補を比較」を押してください。');
  if(points.length===2){selectMode=false; }
});}
function clearLine(){const m=getMap();if(drawn&&m)m.removeLayer(drawn);drawn=null;}
const coord=p=>`${p[1]},${p[0]}`;
function sampleRoute(coords,n=4){const a=[];for(let i=0;i<n;i++){let idx=Math.round(i*(coords.length-1)/(n-1));a.push(coords[idx]);}return a;}
async function jsonFetch(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(url,{signal:c.signal});if(!r.ok)throw Error('HTTP '+r.status);return await r.json();}finally{clearTimeout(t);}}
function pointInRing(pt,ring){const x=pt[1],y=pt[0];let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(((a[1]>y)!==(b[1]>y))&&(x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]))inside=!inside;}return inside;}
function inPolygon(pt,polygon){return polygon?.length>0&&pointInRing(pt,polygon[0])&&!polygon.slice(1).some(r=>pointInRing(pt,r));}
function inHazard(pt){const geo=typeof floodGeojsonData!=='undefined'?floodGeojsonData:null;if(!geo)return false;const features=geo.type==='FeatureCollection'?geo.features:[geo.type==='Feature'?geo:{geometry:geo}];return features.some(f=>{const g=f.geometry;if(!g)return false; if(g.type==='Polygon')return inPolygon(pt,g.coordinates);if(g.type==='MultiPolygon')return g.coordinates.some(p=>inPolygon(pt,p));return false;});}
function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((x,y)=>x+y,0)/v.length:null;}
function rainAt(data,i){const x=data?.[i]?.current?.precipitation;return typeof x==='number'&&Number.isFinite(x)?x:null;}
function elevations(data){return Array.isArray(data?.elevation)?data.elevation:[];}
// Screening heuristic, NOT a flood forecast or proof of road passability.
function evaluate(route, rain, elev){
 const samples=sampleRoute(route.geometry.coordinates.map(([lng,lat])=>[lat,lng]),Math.min(20,route.geometry.coordinates.length));
 const rv=rain.map((_,i)=>rainAt(rain,i));const ev=elevations(elev);
 const complete=rv.length===samples.length&&ev.length===samples.length&&rv.every(Number.isFinite)&&ev.every(Number.isFinite);
 const maxRain=rv.filter(Number.isFinite).length?Math.max(...rv.filter(Number.isFinite)):null;
 const avgElevation=mean(ev);
 const hazardHits=samples.filter(inHazard).length;
 // Only a screening indicator: low elevation is not itself evidence of flooding.
 // Relative dips plus intense precipitation raise concern, but cannot locate drains/underpasses.
 let concern=0, high=0;
 for(let i=0;i<samples.length;i++){
  const rainNow=rv[i],height=ev[i];if(!Number.isFinite(rainNow)||!Number.isFinite(height))continue;
  const nearby=ev.slice(Math.max(0,i-2),Math.min(ev.length,i+3)).filter(Number.isFinite);
  const dip=nearby.length>=3?Math.max(...nearby)-height:0;
  const hazard=inHazard(samples[i]);
  const severe=rainNow>=30&&(hazard||dip>=3);
  const elevated=rainNow>=15&&(hazard||dip>=2)||rainNow>=50;
  if(severe)high++;if(elevated)concern++;
 }
 const level=!complete?'unknown':high>0?'high':concern>0?'caution':'unconfirmed';
 const score=(high*1000)+(concern*100)+(hazardHits*25)+(maxRain??0)*2+route.distance/10000;
 return {samples,maxRain,avgElevation,hazardHits,lowSamples:0,score,complete,level,concern,high};
}
async function weatherAndElevation(samples){const lat=samples.map(x=>x[0].toFixed(5)).join(','),lon=samples.map(x=>x[1].toFixed(5)).join(',');const [weather,elev]=await Promise.allSettled([
 jsonFetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation&timezone=Asia%2FTokyo`),
 jsonFetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`)
]);let w=weather.status==='fulfilled'?weather.value:null; if(w&&!Array.isArray(w))w=[w];return {w,e:elev.status==='fulfilled'?elev.value:null};}
window.autoRouteToRestaurant=async(id)=>{
 const r=(typeof restaurants!=='undefined'?restaurants:[]).find(x=>String(x.id)===String(id));
 if(!r || !r.approved || !Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lng)) || (Number(r.lat)===0&&Number(r.lng)===0)){status('店舗の位置情報がありません。');return;}
 if(typeof currentUserLocation==='undefined'||!currentUserLocation){status('先に現在地を取得してください。');return;}
 connect();if(!bound){status('地図を読み込めません。');return;}
 points=[[currentUserLocation.lat,currentUserLocation.lng],[Number(r.lat),Number(r.lng)]];
 selectMode=false;marks.forEach(x=>bound.removeLayer(x));marks=[];
 // 既存の現在地・店舗マーカーを利用し、重複マーカーは作らない。
 
 await window.autoRouteCalculate();
};
window.autoRouteAllRestaurants=()=>{
 const list=$('autoRouteStoreList');if(!list)return;list.replaceChildren();connect();
 if(typeof currentUserLocation==='undefined'||!currentUserLocation){status('現在地の取得が必要です。');if(typeof showLocation==='function')showLocation(()=>window.autoRouteAllRestaurants());return;}
 const stores=(typeof restaurants!=='undefined'?restaurants:[])
   .filter(r=>r.approved && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && (Number(r.lat)!==0||Number(r.lng)!==0))
   .map(r=>({r,km:bound?bound.distance([currentUserLocation.lat,currentUserLocation.lng],[Number(r.lat),Number(r.lng)])/1000:Infinity}))
   .filter(x=>x.km<=30).sort((a,b)=>a.km-b.km);
 if(!stores.length){status('現在地から30km以内に登録店舗がありません。');return;}
 status('店舗を選ぶと現在地からの道路候補・雨量・標高から冠水リスクを簡易推定して比較します。');
 for(const {r,km} of stores){const item=document.createElement('div');item.className='auto-route-result';const name=document.createElement('strong');name.textContent=(r.name||'店舗')+'（直線約'+km.toFixed(1)+'km）';const b=document.createElement('button');b.type='button';b.textContent='この店舗まで自動計算';b.addEventListener('click',()=>window.autoRouteToRestaurant(r.id));item.append(name,b);list.append(item);}
};
window.autoRouteCalculate=async()=>{
 if(points.length!==2){status('まず地図で出発地と目的地を指定してください。');return;}
 const btn={disabled:false};clearLine();$('autoRouteResults').replaceChildren();status('自動車向け道路候補と雨量・標高を取得しています…');
 try{
  const [a,b]=points;const dist=bound.distance(L.latLng(a),L.latLng(b));if(dist>30000)throw Error('現在は直線距離30km以内の道路候補のみ対応しています。');
  const url=`https://router.project-osrm.org/route/v1/driving/${coord(a)};${coord(b)}?overview=full&geometries=geojson&alternatives=true&steps=false`;
  const data=await jsonFetch(url);if(!Array.isArray(data.routes)||!data.routes.length)throw Error('道路の経路候補が見つかりません。');
  const known=typeof window.verifiedFloodCoverage==='function'?window.verifiedFloodCoverage():{count:0,updated:null};
  if(!known.updated)status('確認済みの冠水・通行止め情報は未取得です。表示する道路候補は未検証で、災害時の移動には使用できません。');
  const routes=data.routes.filter(r=>!known.updated || (typeof window.verifiedFloodRouteConflict==='function' && !window.verifiedFloodRouteConflict(r.geometry.coordinates))).slice(0,3);
  if(!routes.length)throw Error('確認済みの冠水・通行止め区間を避ける道路候補がありません。移動を控え、公式情報をご確認ください');const checks=await Promise.all(routes.map(async r=>{
    const s=sampleRoute(r.geometry.coordinates.map(([lng,lat])=>[lat,lng]),Math.min(20,r.geometry.coordinates.length));const {w,e}=await weatherAndElevation(s);
    return {route:r, risk:evaluate(r,w||[],e)};
  }));
  candidates=checks.sort((x,y)=>Number(y.risk.complete)-Number(x.risk.complete)||x.risk.score-y.risk.score);lastSelected=0;
  const acceptable=candidates.findIndex(c=>c.risk.complete&&c.risk.level!=='high');
  const chosen=acceptable>=0?acceptable:-1;
  const allIncomplete=candidates.every(x=>!x.risk.complete);
  if(allIncomplete){status('雨量または標高の情報が不足しています。リスク順位を判断できません。以下は道路候補の参考表示のみです。');}
  for(const [i,c] of candidates.entries()){
   const div=document.createElement('div');div.className='auto-route-result';
   const rain=c.risk.maxRain===null?'取得不可':`${c.risk.maxRain.toFixed(1)} mm/h`;
   const elev=c.risk.avgElevation===null?'取得不可':`${c.risk.avgElevation.toFixed(0)} m`;
   const title=document.createElement('strong');title.textContent=`道路候補${i+1}｜約${(c.route.distance/1000).toFixed(1)}km／約${Math.round(c.route.duration/60)}分${!known.updated?'（規制未確認）':c.risk.complete?'':'（評価不完全）'}`;
   const details=document.createElement('p');details.className='v22-risk-details';details.textContent=`簡易冠水リスク：${({high:'高い可能性（推定）',caution:'注意（推定）',unconfirmed:'冠水未確認',unknown:'判定不可'})[c.risk.level]} ／最大降水量 ${rain} ／平均標高 ${elev} ／浸水想定区域との重複 ${c.risk.hazardHits}地点${c.risk.complete?'':' ／データ不足'}`;
   const b=document.createElement('button');b.textContent='地図で確認';b.onclick=()=>window.autoRouteShow(i);
   div.append(title,details,b);$('autoRouteResults').append(div);
  }
  if(chosen>=0)window.autoRouteShow(chosen);
  else {clearLine();status('低リスクと評価できる候補がありません。ルートの推奨表示を控えます。冠水・規制の公式情報をご確認ください。');return;}
  if(!allIncomplete)status(known.updated?'読み込んだ確認済み情報と重なる候補を除外しました。ただし未掲載の冠水・通行止めや避難情報は未反映です。災害時の移動経路として使用しないでください。':'道路候補を参考表示しています。確認済みの冠水・通行止め情報が未取得のため、通行可否は確認できません。災害時の移動には使用しないでください。');
 }catch(e){status('候補を作成できませんでした：'+(e.message||'通信エラー')+'。公式防災情報をご確認ください。');}
 finally{btn.disabled=false;}
};
window.v22RefreshRouteVisibility=()=>{const m=getMap();if(!m||!drawn)return;if(window.v22LayerVisible?.('route')===false){if(m.hasLayer(drawn))m.removeLayer(drawn);}else if(!m.hasLayer(drawn))drawn.addTo(m);};
window.autoRouteShow=i=>{const c=candidates[i],m=getMap();if(!c||!m)return;lastSelected=i;clearLine();drawn=L.polyline(c.route.geometry.coordinates.map(([lon,lat])=>[lat,lon]),{color:'#1c70c5',weight:6,opacity:.8,dashArray:'10 6'});if(window.v22LayerVisible?.('route')!==false)drawn.addTo(m);m.fitBounds(drawn.getBounds(),{padding:[24,24]});};
window.autoRouteOpenGoogle=()=>{if(points.length!==2){status('先に2点を指定してください。');return;}const q=new URLSearchParams({api:'1',origin:points[0].join(','),destination:points[1].join(','),travelmode:'driving'});window.open('https://www.google.com/maps/dir/?'+q.toString(),'_blank','noopener,noreferrer');status('Googleマップの通常経路を開きました。アプリの候補ルートは引き継がれません。');};
window.autoRouteSelectStoreOnMap=(id)=>{
 const r=(typeof restaurants!=='undefined'?restaurants:[]).find(x=>String(x.id)===String(id));
 if(!r||!r.approved)return;
 connect();
 status('現在地を取得して「'+(r.name||'店舗')+'」への道路候補を表示します。');
 if(typeof currentUserLocation!=='undefined'&&currentUserLocation){window.autoRouteToRestaurant(id);return;}
 if(typeof showLocation==='function')showLocation(()=>window.autoRouteToRestaurant(id));
 else status('現在地の取得ができません。');
};
const timer=setInterval(()=>{connect();if(bound)clearInterval(timer);},500);setTimeout(()=>clearInterval(timer),30000);
})();
