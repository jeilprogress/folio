// Only draft content is shared. Editor selection, theme and Spotify stay local.
const syncDialog = $('syncDialog');
const config = window.folioFirebase;
const digest = async value => {
 const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
 return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
};
function drafts(stories) {
 return stories.map(({id,name,scenes}) => ({id,name,scenes:scenes.map(({id,title,html}) => ({id,title,html}))}));
}
async function fingerprints(stories) {
 return Object.fromEntries(await Promise.all(stories.map(async s => [s.id, await digest(s)])));
}
function combine(local, remote, baseline, localHashes, remoteHashes) {
 const known = new Map(remote.map(s => [s.id,s]));
 const result = new Map(known);
 for (const s of local) {
  const id=s.id, l=localHashes[id], r=remoteHashes[id], b=baseline[id];
  if (l===r || l===b) continue;
  if (r===b || !known.has(id)) result.set(id,s);
  else {
   const copyId=id+'-copy-'+l;
   result.set(copyId,{...s,id:copyId,name:s.name+' (conflict copy)'});
  }
 }
 for (const id of Object.keys(baseline)) {
  if (!Object.hasOwn(localHashes,id) && remoteHashes[id]===baseline[id]) result.delete(id);
 }
 // Follow a local reorder if the relative order of existing local stories changed.
 const previous=Object.keys(baseline).filter(id=>Object.hasOwn(localHashes,id));
 const order=local.map(s=>s.id).filter(id=>Object.hasOwn(baseline,id));
 if (JSON.stringify(previous)!==JSON.stringify(order)) {
  const ids=[...new Set([...local.map(s=>s.id),...result.keys()])];
  return ids.filter(id=>result.has(id)).map(id=>result.get(id));
 }
 return [...result.values()];
}
let auth, authApi, user, running=false, timer, needsRun=false, message='Sync';
function status(value) {
 message=value;
 $('syncMessage').textContent=value;
 $('syncButton').textContent=value==='Synced'?'● Synced':'Sync';
 if (!readError && user) $('saved').textContent=value;
}
function schedule(delay=900) {
 if (!user) return;
 clearTimeout(timer); timer=setTimeout(synchronize,delay);
}
window.addEventListener('folio-save',()=>{if(user){status('Saved here · sync pending');schedule()}});
function persistSync(stories, metadata) {
 const previous=data, wasHome=$('room').hidden;
 const selectedStory=story()?.id, selectedScene=story() && scene()?.id;
 const before=story() && scene()?.html;
 const changed=JSON.stringify(drafts(data.stories))!==JSON.stringify(stories);
 const remembered=new Map(data.stories.map(s=>[s.id,s.lastScene]));
 const existing=new Set(data.stories.flatMap(s=>s.scenes.map(v=>v.html)));
 const merged=changed?stories.map(s=>({...s,lastScene:remembered.get(s.id),
  scenes:s.scenes.map(v=>({...v,html:existing.has(v.html)?v.html:clean(v.html)}))})):data.stories;
 data={...data,stories:merged,sync:metadata};
 if(!save(false)){data=previous;throw Error('Local save failed. Export a backup before continuing.')}
 if(!changed)return;
 if(wasHome || !merged.some(s=>s.id===selectedStory))goHome();
 else render(selectedScene===scene().id && before===scene().html);
}
async function synchronize() {
 if (!user) return;
 if (running){needsRun=true;return}
 if (modal.open || document.querySelector('.storyGrip:active')){schedule();return}
 running=true;
 const account=user, active=()=>account===user;
 try {
  if(readError || localStorage.getItem(key)!==base)throw Error('Reload this tab before syncing.');
  if(data.sync && data.sync.owner!==account.uid)throw Error('Sign in with the account linked to these local drafts.');
  if(!navigator.onLine)throw Error('Saved here · offline');
  const token=await account.getIdToken();
  const root=config.databaseURL.replace(/\/$/,'')+'/folios/'+account.uid;
  // Test-mode rules allow anonymous readers. Keep drafts local until locked.
  const probe=await fetch(root+'/revision.json',{cache:'no-store'});
  if(probe.ok)throw Error('Sync paused · publish private database rules first.');
  if(![401,403].includes(probe.status))throw Error('Could not verify database privacy.');
  async function request(path, options={}) {
   const response=await fetch(root+path+'.json?auth='+encodeURIComponent(token),{cache:'no-store',...options});
   if(response.status===412){needsRun=true;throw Error('Another device saved · retrying')}
   if(!response.ok)throw Error(response.status===401||response.status===403?'Sync denied · check account and database rules':'Saved here · retrying sync');
   return response;
  }
  const rev=await (await request('/revision')).json();
  if(!active())return;
  const local=drafts(data.stories), hashes=await fingerprints(local);
  const baseline=data.sync?.hashes||{};
  if(data.sync && rev===data.sync.revision && JSON.stringify(hashes)===JSON.stringify(baseline)){
   if(JSON.stringify(local)===JSON.stringify(drafts(data.stories)))status('Synced');else needsRun=true;
   return;
  }
  const response=await request('',{headers:{'X-Firebase-ETag':'true'}});
  const cloud=await response.json();
  const remote=cloud===null?[]:JSON.parse(cloud.content);
  if(!valid({stories:remote}))throw Error('Cloud drafts could not be read. Local drafts are safe.');
  const remoteHashes=await fingerprints(remote);
  const combined=combine(local,remote,baseline,hashes,remoteHashes);
  const combinedHashes=await fingerprints(combined);
  if(!active() || modal.open || JSON.stringify(local)!==JSON.stringify(drafts(data.stories))){needsRun=true;return}
  let revision=cloud?.revision??null;
  if(JSON.stringify(combined)!==JSON.stringify(remote)){
   revision=uid();
   await request('',{method:'PUT',headers:{'If-Match':response.headers.get('etag'),'Content-Type':'application/json'},
    body:JSON.stringify({revision,content:JSON.stringify(combined)})});
  }
  if(!active())return;
  // Reconcile edits made while the conditional upload was in flight.
  let current, currentHashes;
  do {current=drafts(data.stories);currentHashes=await fingerprints(current)}
  while(active() && JSON.stringify(current)!==JSON.stringify(drafts(data.stories)));
  if(!active())return;
  const final=combine(current,combined,hashes,currentHashes,combinedHashes);
  persistSync(final,{owner:account.uid,revision,hashes:combinedHashes});
  needsRun ||= JSON.stringify(drafts(data.stories))!==JSON.stringify(combined);
  status(needsRun?'Saved here · sync pending':'Synced');
 } catch(error){if(active())status(error.message==='Failed to fetch'?'Saved here · waiting for connection':error.message)}
 finally{running=false;if(needsRun){needsRun=false;schedule(300)}}
}
function showSync(){syncDialog.showModal();$('syncMessage').textContent=message}
$('syncButton').onclick=showSync;
$('roomSync').onclick=()=>{closePanels();showSync()};
$('syncClose').onclick=()=>syncDialog.close();
async function initializeSync(){
 if(!config?.databaseURL){status('Cloud sync is awaiting Firebase setup. Your drafts are saved on this device.');return}
 const sdk='https://www.gstatic.com/firebasejs/11.10.0/';
 const [app,api]=await Promise.all([import(sdk+'firebase-app.js'),import(sdk+'firebase-auth.js')]);
 authApi=api;auth=api.getAuth(app.initializeApp(config));
 api.onAuthStateChanged(auth,account=>{
  user=account;
  $('syncLogin').hidden=!!account;$('syncLogout').hidden=!account;
  $('syncAccount').textContent=account?.email||'Use the same email on your laptop and phone.';
  status(account?'Checking for changes…':'Sign in to sync');
  if(account)schedule(0);else $('saved').textContent='● Saved on this device';
 });
}
$('syncLogin').onsubmit=async event=>{
 event.preventDefault();
 const email=$('syncEmail').value.trim(), password=$('syncPassword').value;
 try{
  if(event.submitter?.id==='syncRegister')await authApi.createUserWithEmailAndPassword(auth,email,password);
  else await authApi.signInWithEmailAndPassword(auth,email,password);
  $('syncPassword').value='';
 }catch(error){status((error.code||'Sign-in failed').replace('auth/','').replaceAll('-',' '))}
};
$('syncLogout').onclick=async()=>{await authApi.signOut(auth);status('Signed out. Drafts remain on this device.')};
window.addEventListener('online',()=>schedule(0));
window.addEventListener('focus',()=>schedule(0));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0)});
setInterval(()=>{if(user&&!document.hidden)synchronize()},15000);
initializeSync().catch(()=>status('Cloud sign-in unavailable. Reload when online.'));
