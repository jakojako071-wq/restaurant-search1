/* V18: Explicitly sourced incident GeoJSON overlay. Not a nationwide real-time feed. */
(()=>{'use strict';
let features=[],layer=null,lastUpdated=null,source='',timer=null;
const $=id=>document.getElementById(id);
const status=s=>{if($('verifiedFloodStatus'))$('verifiedFloodStatus').textContent=s;};
function mapRef(){try{return typeof map!=='undefined'?map:null;}catch{return null;}}
function validFeature(f){
 const p=f?.properties||{}; const g=f?.geometry;
 if(!g||!['Point','LineString','MultiLineString','Polygon','MultiPolygon'].includes(g.type))return false;
 if(!['confirmed_flood','road_closed'].includes(p.status))return false;
 if(typeof p.source!=='string'||!/^https:\/\//.test(p.source))return false;
 if(!p.observed_at||!Number.isFinite(Date.parse(p.observed_at)))return false;
 if(Date.now()-Date.parse(p.observed_at)>6*3600000||Date.parse(p.observed_at)>Date.now()+600000)return false;
 if(p.expires_at && Date.parse(p.expires_at)<Date.now())return false;
 return true;
}
function paint(){const m=mapRef();if(!m||!window.L)return;if(layer)m.removeLayer(layer);
 layer=L.geoJSON({type:'FeatureCollection',features},{style:f=>({color:f.properties.status==='road_closed'?'#bc3030':'#df6d18',weight:7,opacity:.9}),pointToLayer:(f,ll)=>L.circleMarker(ll,{radius:11,color:'#bc3030',fillOpacity:.4}),onEachFeature:(f,l)=>{
  const p=f.properties;const div=document.createElement('div');const strong=document.createElement('strong');strong.textContent=p.status==='road_closed'?'通行止め':'冠水確認';div.append(strong,document.createElement('br'),document.createTextNode('確認日時: '+p.observed_at+' '));const a=document.createElement('a');a.href=p.source;a.textContent='情報源';a.target='_blank';a.rel='noopener noreferrer';div.append(a);l.bindPopup(div);
 }});if(window.v22LayerVisible?.('incident')!==false)layer.addTo(m);
}
function geometryPoints(f){const g=f.geometry;if(g.type==='Point')return [g.coordinates];if(g.type==='LineString')return g.coordinates;if(g.type==='MultiLineString')return g.coordinates.flat();if(g.type==='Polygon')return g.coordinates.flat();if(g.type==='MultiPolygon')return g.coordinates.flat(2);return [];}
function distM(a,b){const lat=(a[1]+b[1])/2*Math.PI/180;return Math.hypot((a[0]-b[0])*111320*Math.cos(lat),(a[1]-b[1])*111320);}
function nearSegment(p,a,b){const lat=p[1]*Math.PI/180,scale=Math.cos(lat);const x=p[0]*scale,y=p[1],ax=a[0]*scale,ay=a[1],bx=b[0]*scale,by=b[1];const t=Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2||1)));return distM(p,[(ax+t*(bx-ax))/scale,ay+t*(by-ay)]);}
window.verifiedFloodRouteConflict=(coords)=>{
 if(!features.length)return false;
 return features.some(f=>{
  const g=f.geometry;const pts=geometryPoints(f);
  // Conservative point/line proximity. Polygon boundaries and interior use point-in-polygon.
  const inside=(p,ring)=>{let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;};
  const polygons=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
  for(let i=0;i<coords.length-1;i++){
   const a=coords[i],b=coords[i+1];const mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
   if(polygons.some(poly=>[a,mid,b].some(p=>inside(p,poly[0])&&!poly.slice(1).some(h=>inside(p,h)))))return true;
   if(pts.some(p=>nearSegment(p,a,b)<(g.type==='Point'?50:25)))return true;
  }
  return false;
 });
};
window.v22RefreshIncidentVisibility=()=>{const m=mapRef();if(!m||!layer)return;if(window.v22LayerVisible?.('incident')===false){if(m.hasLayer(layer))m.removeLayer(layer);}else if(!m.hasLayer(layer))layer.addTo(m);};
window.verifiedFloodCoverage=()=>({count:features.length,updated:lastUpdated,source});
window.loadVerifiedFlood=async()=>{
 const url=window.FLOOD_VERIFIED_FEED_URL;if(!url||!/^https:\/\//.test(url)){status('道路規制の自動配信元は未設定です。降水量はルート選択時に取得します。冠水・通行止めは公式サイトで確認してください。');return;}
 status('冠水・道路規制データを確認しています…');
 try{const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),12000);let r;try{r=await fetch(url,{signal:ctl.signal,cache:'no-store'});}finally{clearTimeout(t);}if(!r.ok)throw Error('HTTP '+r.status);
 const raw=await r.json();if(raw.type!=='FeatureCollection'||!Array.isArray(raw.features))throw Error('GeoJSON FeatureCollectionではありません');
 if(raw.features.length>10000)throw Error('データ件数が多すぎます');
 features=raw.features.filter(validFeature);source=url;lastUpdated=new Date();paint();status('有効な冠水・通行止め情報 '+features.length+'件。最終取得 '+lastUpdated.toLocaleTimeString('ja-JP')+'。未掲載道路の安全は確認されていません。');
 if(timer)clearInterval(timer);timer=setInterval(()=>window.loadVerifiedFlood(),5*60000);
 }catch(e){features=[];lastUpdated=null;if(layer){mapRef()?.removeLayer(layer);layer=null;}status('データ取得失敗：'+e.message+'。安全な経路として案内できません。');}
};
window.addEventListener('load',()=>{window.loadVerifiedFlood();let count=0;const i=setInterval(()=>{if(mapRef()){paint();clearInterval(i);}if(++count>30)clearInterval(i);},1000);});
})();
