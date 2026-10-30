(function(){
  'use strict';
  /* =====================================================================
     接力绘 · Supabase 数据层
     保留原有 UI / DOM / 动效；所有业务数据直接读写 Supabase。
     ===================================================================== */

  var SUPABASE_URL = 'https://txhjgdtzcolhpqlqzecf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4aGpnZHR6Y29saHBxbHF6ZWNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNzk3MTksImV4cCI6MjEwODc1NTcxOX0.J7Iuh-DOHcWltAR3p-Ix0bPx8FFsSfNMKtreubsExyM';
  if(!window.supabase || typeof window.supabase.createClient !== 'function'){
    throw new Error('Supabase SDK 未加载，请先加载 @supabase/supabase-js@2');
  }
  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
  });
  window.__supabaseClient = supabase;

  var AUTH_KEY = 'relay-draw:auth';
  var ADMIN = { account:'765528515' };
  var DAY = 86400000;
  var currentUserId = null;
  window.RELAY_USER_ID = null;
  function setCurrentUserId(id){ currentUserId = id || null; window.RELAY_USER_ID = currentUserId; }
  var isAdminSession = false;
  var cachedEvents = [];
  var authError = null;

  /* localStorage 只用于兼容原 UI 的“管理员入口”显示状态，不保存报名记录或业务数据。 */
  var Persist = (function(){
    var mem = {};
    return {
      ok: (function(){ try{ var k='__relay_t'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return true; }catch(e){ return false; } })(),
      get:function(k){ try{ return localStorage.getItem(k); }catch(e){ return Object.prototype.hasOwnProperty.call(mem,k) ? mem[k] : null; } },
      set:function(k,v){ try{ localStorage.setItem(k,v); return true; }catch(e){ mem[k]=v; return false; } },
      del:function(k){ try{ localStorage.removeItem(k); }catch(e){} delete mem[k]; }
    };
  })();

  var RULES_3 = [
    '每期每人只认领一个棒位，认领后不能自己改，需要取消或换棒请找管理员。',
    '拿到上一棒的图之后，接着这张画下去，不要重画整体构图。',
    '交稿窗口 72 小时，最短边不小于 1600px，PNG 或 JPG 都行。',
    '三个关键词必须出现在画面里，但不要求写得直白。',
    '第六棒收尾后，管理员会把成品、最佳成品和变化最大的一棒放进作品馆。'
  ];
  var RULES_2 = [
    '每人只认领一个棒位，换棒请找管理员。',
    '只延续画面，不改前一棒已经定下的构图。',
    '交稿窗口 72 小时，最短边不小于 1600px。',
    '三个关键词都要在画里出现。'
  ];
  var RULES_1 = ['每人只认领一个棒位。','接着上一棒画，不要推翻重来。','交稿窗口 72 小时。'];

  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function isoDay(offset){
    var t = new Date(Date.now() + (offset || 0) * DAY);
    return t.getFullYear() + '-' + pad(t.getMonth()+1) + '-' + pad(t.getDate());
  }
  function today(){ return isoDay(0); }
  function addDays(dstr, n){
    if(!dstr) return '';
    var t = new Date(String(dstr).slice(0,10) + 'T00:00:00');
    if(isNaN(t.getTime())) return '';
    t.setDate(t.getDate() + n);
    return t.getFullYear() + '-' + pad(t.getMonth()+1) + '-' + pad(t.getDate());
  }
  function daysBetween(a, b){
    if(!a || !b) return null;
    var x = new Date(String(a).slice(0,10) + 'T00:00:00').getTime();
    var y = new Date(String(b).slice(0,10) + 'T00:00:00').getTime();
    return !isFinite(x) || !isFinite(y) ? null : Math.round((y-x)/DAY);
  }
  function uid(p){ return (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
  function failIf(error){ if(error) throw error; }
  function friendlyError(error, fallback){
    if(error && error.message) return error.message;
    return fallback || '操作失败，请稍后重试';
  }
  function formatClaimedAt(value){
    if(!value) return '';
    var d = new Date(value);
    if(isNaN(d.getTime())) return String(value).slice(5,16).replace('T',' ');
    return pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayPart(value){ return value ? String(value).slice(0,10) : ''; }
  function asArray(value){
    if(Array.isArray(value)) return value;
    if(value == null || value === '') return [];
    if(typeof value === 'string'){
      try{ var parsed = JSON.parse(value); if(Array.isArray(parsed)) return parsed; }catch(ignore){}
      return value.split(/[,，、\n]+/).map(function(item){ return item.trim(); }).filter(Boolean);
    }
    return [];
  }

  async function checkAdminUser(userId){
    if(!userId){ isAdminSession = false; Persist.del(AUTH_KEY); return false; }
    var result = await supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
    if(result.error){ isAdminSession = false; Persist.del(AUTH_KEY); return false; }
    isAdminSession = !!result.data;
    if(isAdminSession) Persist.set(AUTH_KEY, '1');
    else Persist.del(AUTH_KEY);
    return isAdminSession;
  }

  async function initAuth(){
    try{
      var sessionResult = await supabase.auth.getSession();
      if(sessionResult.error) throw sessionResult.error;
      var session = sessionResult.data && sessionResult.data.session;
      if(session && session.user){
        setCurrentUserId(session.user.id);
        await checkAdminUser(currentUserId);
        return session.user;
      }
      var anon = await supabase.auth.signInAnonymously();
      if(anon.error) throw anon.error;
      setCurrentUserId(anon.data && anon.data.user ? anon.data.user.id : null);
      isAdminSession = false;
      Persist.del(AUTH_KEY);
      if(!currentUserId) throw new Error('匿名登录未返回用户 UID');
      return anon.data.user;
    }catch(error){
      authError = error;
      console.error('[接力绘] Supabase 初始化/匿名登录失败：', error);
      return null;
    }
  }
  var authReady = initAuth();
  supabase.auth.onAuthStateChange(function(event, session){
    setCurrentUserId(session && session.user ? session.user.id : null);
    if(event === 'SIGNED_OUT'){
      isAdminSession = false;
      Persist.del(AUTH_KEY);
    }
  });

  async function ensureUser(){
    await authReady;
    var sessionResult = await supabase.auth.getSession();
    if(sessionResult.error) throw sessionResult.error;
    var session = sessionResult.data && sessionResult.data.session;
    if(session && session.user){
      setCurrentUserId(session.user.id);
      return currentUserId;
    }
    var anon = await supabase.auth.signInAnonymously();
    if(anon.error) throw anon.error;
    setCurrentUserId(anon.data && anon.data.user ? anon.data.user.id : null);
    if(!currentUserId) throw new Error('匿名登录失败，请检查 Supabase 是否开启 Anonymous Sign-ins');
    return currentUserId;
  }

  var STATUS = {
    open:    { key:'open',    label:'招募中', cls:'st-open',    hint:'报名开放中' },
    ongoing: { key:'ongoing', label:'进行中', cls:'st-ongoing', hint:'画手中，暂不接受报名' },
    closed:  { key:'closed',  label:'已收官', cls:'st-closed',  hint:'这一期已经收官' }
  };
  function statusOf(ev){ return STATUS[ev.status] || STATUS.closed; }

  function getReg(){
    var out = {};
    if(!currentUserId) return out;
    cachedEvents.forEach(function(ev){
      var mine = (ev.slots || []).filter(function(slot){ return slot.claimed_by && slot.claimed_by === currentUserId; })[0];
      if(mine) out[ev.id] = { name:mine.name, slot:mine.no, claimed_by:mine.claimed_by };
    });
    return out;
  }

  function imageUrl(imagePath){
    if(!imagePath) return '';
    if(/^(https?:|data:|blob:)/i.test(String(imagePath))) return String(imagePath);
    var publicResult = supabase.storage.from('works').getPublicUrl(String(imagePath));
    return publicResult && publicResult.data ? publicResult.data.publicUrl : '';
  }
  function storagePathFromValue(value){
    if(!value || /^(https?:|data:|blob:)/i.test(String(value))) return null;
    return String(value);
  }
  function dataUrlToBlob(dataUrl){
    if(typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0){
      throw new Error('作品图片格式无效');
    }
    var comma = dataUrl.indexOf(',');
    if(comma < 0) throw new Error('作品图片数据不完整');
    var meta = dataUrl.slice(0, comma);
    var body = dataUrl.slice(comma + 1);
    var mimeMatch = meta.match(/^data:([^;,]+)/i);
    var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    var bytes;
    if(/;base64/i.test(meta)){
      var binary = atob(body);
      bytes = new Uint8Array(binary.length);
      for(var i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    }else{
      var decoded = decodeURIComponent(body);
      bytes = new TextEncoder().encode(decoded);
    }
    return { blob:new Blob([bytes], { type:mime }), mime:mime };
  }
  function imageExtension(mime){
    if(mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    if(mime === 'image/png') return 'png';
    if(mime === 'image/webp') return 'webp';
    if(mime === 'image/gif') return 'gif';
    if(mime === 'image/svg+xml') return 'svg';
    return 'bin';
  }
  async function uploadImage(value, roundId, slotId){
    try{
      if(!value) throw new Error('没有可上传的图片');
      var converted;
      if(typeof Blob !== 'undefined' && value instanceof Blob){
        converted = { blob:value, mime:value.type || 'image/jpeg' };
      }else if(typeof value === 'string' && /^data:/i.test(value)){
        converted = dataUrlToBlob(value);
      }else if(typeof value === 'string' && /^https?:/i.test(value)){
        return { image_path:value, url:value, uploaded:false };
      }else{
        throw new Error('图片数据格式不支持');
      }
      if(!converted.blob || !converted.blob.size) throw new Error('图片转换结果为空');
      if(converted.blob.size > 8 * 1024 * 1024) throw new Error('压缩后的图片仍超过 8MB，请换一张图片');
      var ext = imageExtension(converted.mime);
      if(ext === 'bin') throw new Error('不支持的图片格式：' + converted.mime);
     var userSession = await supabase.auth.getSession();
var myUid = userSession.data.session ? userSession.data.session.user.id : 'anon';
var path = myUid + '/' + String(roundId) + '/' + String(slotId || 'unassigned') + '/' + uid('img-') + '.' + imageExtension(converted.mime);
      var uploadResult = await supabase.storage.from('works').upload(path, converted.blob, {
        contentType:converted.mime,
        cacheControl:'3600',
        upsert:false
      });
      if(uploadResult.error){
        console.error('[接力绘] Supabase Storage 上传失败', {path:path, size:converted.blob.size, mime:converted.mime, error:uploadResult.error});
        throw new Error('图片上传失败：' + (uploadResult.error.message || uploadResult.error.error || 'Storage 请求失败'));
      }
      var publicResult = supabase.storage.from('works').getPublicUrl(path);
      return { image_path:uploadResult.data && uploadResult.data.path ? uploadResult.data.path : path,
        url:publicResult && publicResult.data ? publicResult.data.publicUrl : '', uploaded:true };
    }catch(error){
      console.error('[接力绘] 图片上传流程异常', error);
      throw error instanceof Error ? error : new Error(String(error && (error.message || error) || '未知上传错误'));
    }
  }
  async function removeStorageImage(path){
    var storagePath = storagePathFromValue(path);
    if(!storagePath) return;
    try{ await supabase.storage.from('works').remove([storagePath]); }catch(error){ console.warn('[接力绘] 删除旧图片失败：', error); }
  }

  function roundRowToEvent(row, slotRows, workRows){
    var slots = slotRows.filter(function(s){ return s.round_id === row.id; }).sort(function(a,b){ return Number(a.position)-Number(b.position); });
    var firstClaim = slots.map(function(s){ return s.claimed_at; }).filter(Boolean).sort()[0];
    var due = dayPart(row.due_at);
    var eventDate = row.created_at ? dayPart(row.created_at) : (firstClaim ? dayPart(firstClaim) : due);
    var signupUntil = due;
    var duration = Number(row.ongoing_days);
    if(!isFinite(duration) || duration < 0) duration = 10;
    var workUntil = signupUntil ? addDays(signupUntil, duration) : '';
    var status = row.status || 'closed';
    if(status === 'open' && signupUntil && today() > signupUntil) status = 'ongoing';
    if(status === 'ongoing' && workUntil && today() > workUntil) status = 'closed';
    var slotsById = {};
    var mappedSlots = slots.map(function(slot){
      var mapped = {
        id:slot.id,
        no:Number(slot.position),
        name:slot.claimant_name || '',
        at:formatClaimedAt(slot.claimed_at),
        claimed_by:slot.claimed_by || null,
        status:slot.status || (slot.claimant_name ? 'taken' : 'empty'),
        label:slot.label || ('第 ' + slot.position + ' 棒')
      };
      slotsById[slot.id] = mapped.no;
      return mapped;
    });
    var mappedWorks = workRows.filter(function(w){ return w.round_id === row.id; }).map(function(work){
      return {
        id:work.id,
        title:work.title || '未命名',
        author:work.author_name || '匿名',
        slot:slotsById[work.slot_id] || 1,
        slot_id:work.slot_id,
        img:imageUrl(work.image_path),
        image_path:work.image_path,
        at:work.created_at ? dayPart(work.created_at).slice(5) : '',
        is_best:!!work.is_best,
        featured_kind:work.featured_kind || null
      };
    }).sort(function(a,b){
      return Number(a.slot)-Number(b.slot) || String(a.id).localeCompare(String(b.id));
    });
    var best = mappedWorks.filter(function(w){ return w.is_best; })[0];
    var change = mappedWorks.filter(function(w){ return w.featured_kind === 'change' || w.featured_kind === 'most_changed'; })[0];
    return {
      id:row.id,
      no:Number(row.no),
      title:row.title || '',
      status:status,
      date:eventDate || '',
      signupUntil:signupUntil,
      workUntil:workUntil,
      keywords:asArray(row.keywords),
      detail:row.description || '',
      rules:asArray(row.rules),
      slots:mappedSlots,
      works:mappedWorks,
      bestId:best ? best.id : '',
      changeId:change ? change.id : ''
    };
  }

  async function listEventsFromSupabase(){
    await authReady;
    var roundsResult = await supabase.from('rounds').select('*').order('no', { ascending:false });
    failIf(roundsResult.error);
    var rounds = roundsResult.data || [];
    if(!rounds.length){ cachedEvents = []; return []; }
    var ids = rounds.map(function(row){ return row.id; });
    /* 棒位和作品互不依赖：并行读取，减少一次完整刷新所需的网络往返。 */
    var reads = await Promise.all([
      supabase.from('slots').select('*').in('round_id', ids).order('position', { ascending:true }),
      supabase.from('works').select('*').in('round_id', ids)
    ]);
    failIf(reads[0].error);
    failIf(reads[1].error);
    var slotRows = reads[0].data || [];
    var workRows = reads[1].data || [];
    var events = rounds.map(function(row){ return roundRowToEvent(row, slotRows, workRows); });

    /* 日期到期后的状态按原有三态规则计算；只有管理员会把自动流转结果写回数据库。 */
    if(isAdminSession){
      var roundById = {};
      rounds.forEach(function(row){ roundById[row.id] = row; });
      var statusWrites = events.filter(function(event){
        return roundById[event.id] && roundById[event.id].status !== event.status;
      }).map(function(event){
        return supabase.from('rounds').update({ status:event.status }).eq('id', event.id).then(function(result){
          if(result.error) console.warn('[接力绘] 自动更新轮次状态失败：', result.error.message);
        });
      });
      await Promise.all(statusWrites);
    }
    cachedEvents = events;
    return events;
  }
  async function loadEventRows(){
    var result = await supabase.from('rounds').select('*').order('no', { ascending:false });
    failIf(result.error);
    return result.data || [];
  }
  async function preventOtherOpen(exceptId){
    /* 只检查仍处于开放状态的轮次及其棒位，不再加载整站作品和全部页面数据。 */
    var roundsResult = await supabase.from('rounds').select('id').eq('status', 'open');
    failIf(roundsResult.error);
    var openRounds = (roundsResult.data || []).filter(function(row){ return row.id !== exceptId; });
    if(!openRounds.length) return;
    var ids = openRounds.map(function(row){ return row.id; });
    var slotsResult = await supabase.from('slots').select('round_id,claimant_name').in('round_id', ids);
    failIf(slotsResult.error);
    var claimed = {};
    (slotsResult.data || []).forEach(function(slot){
      if(slot.claimant_name) claimed[slot.round_id] = true;
    });
    var writes = openRounds.map(function(round){
      return supabase.from('rounds').update({ status:claimed[round.id] ? 'ongoing' : 'closed' }).eq('id', round.id);
    });
    var results = await Promise.all(writes);
    results.forEach(function(result){ failIf(result.error); });
  }
  function payloadToRoundRow(payload, isCreate){
    var row = {};
    if(Object.prototype.hasOwnProperty.call(payload, 'no')) row.no = Number(payload.no);
    if(Object.prototype.hasOwnProperty.call(payload, 'title')) row.title = payload.title || '';
    else if(isCreate) row.title = (payload.keywords || []).join(' · ') || ('第 ' + payload.no + ' 期接龙');
    if(Object.prototype.hasOwnProperty.call(payload, 'keywords')) row.keywords = payload.keywords || [];
    if(Object.prototype.hasOwnProperty.call(payload, 'detail')) row.description = payload.detail || '';
    if(Object.prototype.hasOwnProperty.call(payload, 'rules')) row.rules = payload.rules || [];
    if(Object.prototype.hasOwnProperty.call(payload, 'status')) row.status = payload.status;
    if(Object.prototype.hasOwnProperty.call(payload, 'signupUntil')) row.due_at = payload.signupUntil || null;
    if(Object.prototype.hasOwnProperty.call(payload, 'ongoing_days')) row.ongoing_days = Number(payload.ongoing_days);
    if(Object.prototype.hasOwnProperty.call(payload, 'signupUntil') && Object.prototype.hasOwnProperty.call(payload, 'workUntil')){
      var days = daysBetween(payload.signupUntil, payload.workUntil);
      if(days !== null) row.ongoing_days = Math.max(0, days);
    }
    return row;
  }
  async function getSlotByPosition(roundId, position){
    var result = await supabase.from('slots').select('*').eq('round_id', roundId).eq('position', position).maybeSingle();
    failIf(result.error);
    return result.data || null;
  }
  async function getWorkById(roundId, workId){
    var result = await supabase.from('works').select('*').eq('round_id', roundId).eq('id', workId).maybeSingle();
    failIf(result.error);
    return result.data || null;
  }

  var API = {
    listEvents:function(){ return listEventsFromSupabase(); },
    getEvent:async function(id){
      var list = await listEventsFromSupabase();
      return list.filter(function(event){ return event.id === id; })[0] || null;
    },
    createEvent:async function(payload){
      await ensureUser();
      if(payload.status === 'open') await preventOtherOpen(null);
      var row = payloadToRoundRow(payload, true);
      var inserted = await supabase.from('rounds').insert(row).select('*').single();
      failIf(inserted.error);
      var round = inserted.data;
      var count = Math.max(1, Number(payload.slotCount) || (payload.slots && payload.slots.length) || 6);
      var slots = (payload.slots && payload.slots.length ? payload.slots : Array.from({length:count}, function(_,index){ return { no:index+1 }; }))
        .map(function(slot, index){
          var position = Number(slot.no) || index+1;
          return { round_id:round.id, position:position, label:'第 ' + position + ' 棒', status:'empty', claimed_by:null, claimant_name:null, claimed_at:null };
        });
      var slotsInserted = await supabase.from('slots').insert(slots);
      if(slotsInserted.error){
        await supabase.from('rounds').delete().eq('id', round.id);
        throw slotsInserted.error;
      }
      return { id:round.id, no:Number(round.no), status:round.status, keywords:round.keywords || [], detail:round.description || '', rules:round.rules || [] };
    },
    updateEvent:async function(id, patch){
      await ensureUser();
      if(patch.status === 'open') await preventOtherOpen(id);
      var updateRow = payloadToRoundRow(patch, false);
      var result = await supabase.from('rounds').update(updateRow).eq('id', id).select('*').maybeSingle();
      failIf(result.error);
      if(!result.data) return null;
      return result.data;
    },
    deleteEvent:async function(id){
      await ensureUser();
      var worksResult = await supabase.from('works').select('id,image_path').eq('round_id', id);
      failIf(worksResult.error);
      var works = worksResult.data || [];
      for(var i=0;i<works.length;i++) await removeStorageImage(works[i].image_path);
      var deleteWorks = await supabase.from('works').delete().eq('round_id', id);
      failIf(deleteWorks.error);
      var deleteSlots = await supabase.from('slots').delete().eq('round_id', id);
      failIf(deleteSlots.error);
      var deleteRound = await supabase.from('rounds').delete().eq('id', id);
      failIf(deleteRound.error);
      return true;
    },
    signup:async function(eventId, slotNo, name){
      var userId = await ensureUser();
      if(!userId) throw new Error('手机端匿名登录未完成，请刷新页面后重试');
      var event = await API.getEvent(eventId);
      if(!event) throw new Error('这一期不存在');
      if(event.status !== 'open') throw new Error('这一期' + statusOf(event).label + '，暂不接受报名');
      if(event.signupUntil && today() > event.signupUntil) throw new Error('报名已经截止了');
      var existing = await supabase.from('slots').select('id,position').eq('round_id', eventId).eq('claimed_by', userId).limit(1);
      failIf(existing.error);
      if(existing.data && existing.data.length) throw new Error('你已经认领过这一期了');

      // 重新从 Supabase 读取目标棒位；不要只依赖页面初次渲染时的 EVENTS 缓存。
      var slot = await getSlotByPosition(eventId, Number(slotNo));
      if(!slot) throw new Error('棒位不存在，请刷新页面后重试');
      var slotIsEmpty = slot.status === 'empty' && !slot.claimed_by && !(slot.claimant_name || '').trim();
      if(!slotIsEmpty) throw new Error('第 ' + slotNo + ' 棒当前不是空位，请刷新后查看最新状态');

      // 使用数据库 RPC 原子认领。这样不依赖手机端 UPDATE ... SELECT 的 RLS 返回行行为，
      // 也能由数据库保证同一用户同一期只认领一次、同一棒位不会被重复认领。
      var claimResult = await supabase.rpc('claim_slot', {
        p_round_id: eventId,
        p_position: Number(slotNo),
        p_name: String(name || '').trim()
      });
      failIf(claimResult.error);
      var claimedRow = Array.isArray(claimResult.data) ? claimResult.data[0] : claimResult.data;
      if(!claimedRow){
        var verify = await getSlotByPosition(eventId, Number(slotNo));
        if(verify && (verify.claimed_by || verify.claimant_name || verify.status === 'taken')){
          throw new Error('这个棒位刚被别人认领了，请刷新后再试');
        }
        throw new Error('报名没有写入数据库：该棒位仍为空。请在 Supabase 执行随附的 claim_slot 修复 SQL 后再试。');
      }
      return { id:claimedRow.id, no:Number(claimedRow.position), name:claimedRow.claimant_name || String(name || '').trim(),
        at:formatClaimedAt(claimedRow.claimed_at), claimed_by:claimedRow.claimed_by };
    },
    cancelSignup:async function(eventId, slotNo){
      await ensureUser();
      var slot = await getSlotByPosition(eventId, slotNo);
      if(!slot) return false;
      var result = await supabase.from('slots').update({ status:'empty', claimed_by:null, claimant_name:null, claimed_at:null })
        .eq('id', slot.id).select('*').maybeSingle();
      failIf(result.error);
      return !!result.data;
    },
    moveSlot:async function(eventId, from, to){
      await ensureUser();
      var source = await getSlotByPosition(eventId, from);
      var target = await getSlotByPosition(eventId, to);
      if(!source || !target) throw new Error('棒位不存在');
      if(!source.claimant_name && !source.claimed_by) throw new Error('这一棒还没有人');
      if(target.status === 'taken' || target.claimed_by || target.claimant_name) throw new Error('目标棒位已经有人了');
      /* 先释放源棒，再认领目标棒，兼容每期同一 UID 唯一的数据库索引；失败时尽量恢复源棒。 */
      var sourceResult = await supabase.from('slots').update({ status:'empty', claimed_by:null, claimant_name:null, claimed_at:null })
        .eq('id', source.id).select('*').maybeSingle();
      failIf(sourceResult.error);
      if(!sourceResult.data) throw new Error('原棒位状态已变化，请刷新后重试');
      var targetResult = await supabase.from('slots').update({ status:'taken', claimed_by:source.claimed_by,
        claimant_name:source.claimant_name, claimed_at:source.claimed_at }).eq('id', target.id).eq('status','empty').select('*').maybeSingle();
      if(targetResult.error || !targetResult.data){
        await supabase.from('slots').update({ status:source.status || 'taken', claimed_by:source.claimed_by,
          claimant_name:source.claimant_name, claimed_at:source.claimed_at }).eq('id', source.id);
        throw targetResult.error || new Error('目标棒位刚被认领，请刷新后再试');
      }
      return true;
    },
    addSlot:async function(eventId){
      await ensureUser();
      var result = await supabase.from('slots').select('position').eq('round_id', eventId).order('position',{ascending:false}).limit(1);
      failIf(result.error);
      var position = result.data && result.data.length ? Number(result.data[0].position)+1 : 1;
      var inserted = await supabase.from('slots').insert({ round_id:eventId, position:position, label:'第 ' + position + ' 棒',
        status:'empty', claimed_by:null, claimant_name:null, claimed_at:null }).select('*').single();
      failIf(inserted.error);
      return position;
    },
    removeSlot:async function(eventId, slotNo){
      await ensureUser();
      var slotsResult = await supabase.from('slots').select('*').eq('round_id', eventId).order('position',{ascending:true});
      failIf(slotsResult.error);
      var slots = slotsResult.data || [];
      if(slots.length <= 1) throw new Error('至少要保留一个棒位');
      var removed = slots.filter(function(slot){ return Number(slot.position) === Number(slotNo); })[0];
      if(!removed) throw new Error('棒位不存在');
      var worksResult = await supabase.from('works').select('id,image_path').eq('round_id', eventId).eq('slot_id', removed.id);
      failIf(worksResult.error);
      var droppedWorks = worksResult.data || [];
      for(var i=0;i<droppedWorks.length;i++) await removeStorageImage(droppedWorks[i].image_path);
      var removedWorks = await supabase.from('works').delete().eq('round_id', eventId).eq('slot_id', removed.id);
      failIf(removedWorks.error);
      var remaining = slots.filter(function(slot){ return slot.id !== removed.id; });
      /* 先移到负序号，再改成连续正序号，兼容 (round_id, position) 唯一约束。 */
      for(var j=0;j<remaining.length;j++){
        var temporary = await supabase.from('slots').update({ position:-(j+1), label:'临时棒位' }).eq('id', remaining[j].id);
        failIf(temporary.error);
      }
      var deleteSlot = await supabase.from('slots').delete().eq('id', removed.id);
      failIf(deleteSlot.error);
      for(var k=0;k<remaining.length;k++){
        var newPosition = k+1;
        var reindexed = await supabase.from('slots').update({ position:newPosition, label:'第 ' + newPosition + ' 棒' }).eq('id', remaining[k].id);
        failIf(reindexed.error);
      }
      return { dropped:droppedWorks.length, remain:remaining.length };
    },
    addWork:async function(eventId, work){
      await ensureUser();
      var slot = await getSlotByPosition(eventId, Math.max(1, Number(work.slot) || 1));
      if(!slot) throw new Error('对应棒位不存在');
      var uploaded = await uploadImage(work.img, eventId, slot.id);
      var row = { round_id:eventId, slot_id:slot.id, title:work.title || '未命名', author_name:work.author || '匿名',
        image_path:uploaded.image_path, is_best:false, featured_kind:null };
      var inserted = await supabase.from('works').insert(row).select('*').single();
      if(inserted.error){ if(uploaded.uploaded) await removeStorageImage(uploaded.image_path); throw inserted.error; }
      return { id:inserted.data.id, title:inserted.data.title, author:inserted.data.author_name, slot:Number(slot.position), img:uploaded.url };
    },
    updateWork:async function(eventId, workId, patch){
      await ensureUser();
      var oldWork = await getWorkById(eventId, workId);
      if(!oldWork) return null;
      var updateRow = {};
      var newUpload = null;
      if(Object.prototype.hasOwnProperty.call(patch,'img')){
        newUpload = await uploadImage(patch.img, eventId, oldWork.slot_id);
        updateRow.image_path = newUpload.image_path;
      }
      if(Object.prototype.hasOwnProperty.call(patch,'title')) updateRow.title = patch.title;
      if(Object.prototype.hasOwnProperty.call(patch,'author')) updateRow.author_name = patch.author;
      if(Object.prototype.hasOwnProperty.call(patch,'slot')){
        var newSlot = await getSlotByPosition(eventId, Number(patch.slot));
        if(!newSlot) throw new Error('对应棒位不存在');
        updateRow.slot_id = newSlot.id;
      }
      var updateResult = await supabase.from('works').update(updateRow).eq('id', workId).eq('round_id', eventId).select('*').maybeSingle();
      if(updateResult.error || !updateResult.data){
        if(newUpload && newUpload.uploaded) await removeStorageImage(newUpload.image_path);
        failIf(updateResult.error);
        return null;
      }
      if(newUpload && newUpload.uploaded) await removeStorageImage(oldWork.image_path);
      var finalRow = updateResult.data;
      var targetSlot = finalRow.slot_id === oldWork.slot_id ? null : await getSlotByPosition(eventId, Number(patch.slot));
      return { id:finalRow.id, title:finalRow.title, author:finalRow.author_name, slot:targetSlot ? Number(targetSlot.position) : undefined,
        img:imageUrl(finalRow.image_path), image_path:finalRow.image_path };
    },
    deleteWork:async function(eventId, workId){
      await ensureUser();
      var work = await getWorkById(eventId, workId);
      if(!work) return false;
      var deleted = await supabase.from('works').delete().eq('id', workId).eq('round_id', eventId);
      failIf(deleted.error);
      await removeStorageImage(work.image_path);
      return true;
    },
    setSpecial:async function(eventId, workId, kind){
      await ensureUser();
      if(kind !== 'best' && kind !== 'change') throw new Error('精选类型无效');
      var target = await getWorkById(eventId, workId);
      if(!target) return false;
      if(kind === 'best'){
        var wasBest = !!target.is_best;
        var clearBest = await supabase.from('works').update({ is_best:false }).eq('round_id', eventId);
        failIf(clearBest.error);
        if(!wasBest){
          var setBest = await supabase.from('works').update({ is_best:true }).eq('id', workId).eq('round_id', eventId);
          failIf(setBest.error);
        }
      }else{
        var wasChange = target.featured_kind === 'change' || target.featured_kind === 'most_changed';
        var clearChange = await supabase.from('works').update({ featured_kind:null }).eq('round_id', eventId)
          .in('featured_kind', ['change','most_changed']);
        failIf(clearChange.error);
        if(!wasChange){
          var setChange = await supabase.from('works').update({ featured_kind:'change' }).eq('id', workId).eq('round_id', eventId);
          failIf(setChange.error);
        }
      }
      return true;
    },
    signInAdmin:async function(account, password){
      await authReady;
      if(String(account || '').trim() !== ADMIN.account) throw new Error('账号或密码不对，再试一次');
      var result = await supabase.auth.signInWithPassword({ email:ADMIN.account + '@relay.local', password:String(password || '') });
      if(result.error) throw new Error('账号或密码不对，再试一次');
      setCurrentUserId(result.data && result.data.user ? result.data.user.id : null);
      var ok = await checkAdminUser(currentUserId);
      if(!ok){
        await supabase.auth.signOut();
        setCurrentUserId(null);
        try{
          var anon = await supabase.auth.signInAnonymously();
          if(!anon.error && anon.data && anon.data.user) setCurrentUserId(anon.data.user.id);
        }catch(ignore){}
        throw new Error('该账号尚未登记为管理员，请检查 admins 表中的 user_id');
      }
      return result.data.user;
    },
    signOutAdmin:async function(){
      Persist.del(AUTH_KEY);
      isAdminSession = false;
      var out = await supabase.auth.signOut();
      if(out.error) throw out.error;
      setCurrentUserId(null);
      var anon = await supabase.auth.signInAnonymously();
      if(anon.error) throw anon.error;
      setCurrentUserId(anon.data && anon.data.user ? anon.data.user.id : null);
      return true;
    },
    currentUserId:function(){ return currentUserId; },
    authReady:function(){ return authReady; },
    isAdmin:function(){ return isAdminSession; }
  };

  /* 兼容原页面可能读取的全局对象；业务数据不再通过 DB.load/save 或 localStorage 持久化。 */
  var DB = { load:function(){ return API.listEvents().then(function(events){ return { events:events }; }); }, save:function(){ return Promise.resolve(true); } };
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  var ICON = {
    arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>',
    close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    zoom:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8.5v5M8.5 11h5"/></svg>',
    info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.6"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l2.6 5.7 6.2.7-4.6 4.2 1.3 6.1L12 16.8 6.5 19.7l1.3-6.1L3.2 9.4l6.2-.7z"/></svg>'
  };
  var S = { view:'home', admin:false, tab:'events', editId:null, admEventId:'', lbList:[], lbIndex:0, modalSlot:0, modalEventId:'' };
  window.__relay = {
    API:API, ICON:ICON, S:S, Persist:Persist, DB:DB, CFG:{ mode:'supabase', base:SUPABASE_URL }, ADMIN:ADMIN,
    AUTH_KEY:AUTH_KEY, getReg:getReg, esc:esc, pad:pad,
    STATUS:STATUS, statusOf:statusOf, daysLeft:function(until){ if(!until) return null; var a=new Date(until+'T00:00:00').getTime(); var b=new Date(today()+'T00:00:00').getTime(); return isNaN(a)?null:Math.round((a-b)/DAY); },
    isoDay:isoDay, today:today, addDays:addDays, DAY:DAY, supabase:supabase
  };
})();

(function(){
'use strict';
var A = window.__relay;
var API = A.API, ICON = A.ICON, S = A.S, Persist = A.Persist, DB = A.DB, ADMIN = A.ADMIN,
    AUTH_KEY = A.AUTH_KEY, getReg = A.getReg, esc = A.esc, CFG = A.CFG,
    STATUS = A.STATUS, statusOf = A.statusOf, daysLeft = A.daysLeft,
    isoDay = A.isoDay, today = A.today, addDays = A.addDays, DAY = A.DAY;
var EVENTS = [];
var $ = function(s, r){ return (r || document).querySelector(s); };

var busyButtons = [];
function setBusy(button, label){
  if(!button || button.disabled) return function(){};
  var item = { button:button, html:button.innerHTML, disabled:button.disabled, aria:button.getAttribute('aria-busy') };
  busyButtons.push(item);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.style.opacity = '.72';
  button.style.cursor = 'wait';
  button.innerHTML = '<span class="relay-btn-spinner" aria-hidden="true" style="display:inline-block;width:11px;height:11px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;margin-right:7px;vertical-align:-1px;animation:relayBtnSpin .7s linear infinite"></span>' + (label || '处理中…');
  return function(){ clearBusy(item); };
}
function clearBusy(item){
  var i = busyButtons.indexOf(item);
  if(i >= 0) busyButtons.splice(i, 1);
  if(!item || !item.button) return;
  var b = item.button;
  if(!b.isConnected) return;
  b.innerHTML = item.html;
  b.disabled = item.disabled;
  if(item.aria == null) b.removeAttribute('aria-busy'); else b.setAttribute('aria-busy', item.aria);
  b.style.opacity = '';
  b.style.cursor = '';
}
function clearAllBusy(){
  busyButtons.slice().forEach(clearBusy);
}
if(!document.getElementById('relay-btn-spinner-style')){
  var busyStyle = document.createElement('style');
  busyStyle.id = 'relay-btn-spinner-style';
  busyStyle.textContent = '@keyframes relayBtnSpin{to{transform:rotate(360deg)}}';
  document.head.appendChild(busyStyle);
}
function refresh(){
  return Promise.resolve(API.listEvents()).then(function(list){ EVENTS = list || []; return EVENTS; }).finally(clearAllBusy);
}
/* API 请求失败时也及时恢复按钮，避免界面一直停留在“处理中”。 */
Object.keys(API).forEach(function(key){
  if(typeof API[key] !== 'function' || API[key].__relayBusyWrapped) return;
  var original = API[key];
  var wrapped = function(){
    var result;
    try{ result = original.apply(this, arguments); }
    catch(error){ clearAllBusy(); throw error; }
    return Promise.resolve(result).catch(function(error){ clearAllBusy(); throw error; });
  };
  wrapped.__relayBusyWrapped = true;
  API[key] = wrapped;
});
function byNo(){
  return EVENTS.slice().sort(function(a,b){ return b.no - a.no; });
}
function openEvent(){
  return byNo().filter(function(e){ return e.status === 'open'; })[0] || null;
}
function ongoingEvent(){
  return byNo().filter(function(e){ return e.status === 'ongoing'; })[0] || null;
}
/* 首页主角：优先招募中，其次进行中，最后是最新一期 */
function activeEvent(){
  return openEvent() || ongoingEvent() || byNo()[0] || null;
}
function dueLine(ev){
  var t = null, txt = '';
  if(ev.status === 'open'){ t = ev.signupUntil; txt = '报名截止'; }
  else if(ev.status === 'ongoing'){ t = ev.workUntil; txt = '交稿截止'; }
  if(!t) return '';
  var d = daysLeft(t);
  var tail = d === null ? '' : (d > 0 ? ' · 还剩 ' + d + ' 天' : (d === 0 ? ' · 今天截止' : ' · 已到期'));
  return txt + ' ' + t.slice(5) + tail;
}
function pad2(n){ return n < 10 ? '0' + n : '' + n; }
function allWorks(){
  var out = [];
  byNo().forEach(function(e){
    (e.works || []).forEach(function(w){ out.push({ w:w, ev:e }); });
  });
  return out;
}
function findWork(ev, id){
  return (ev.works || []).filter(function(w){ return w.id === id; })[0] || null;
}
function autoImg(){
  return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#E3DBCD"/><text x="200" y="256" font-family="sans-serif" font-size="15" fill="#9A9084" text-anchor="middle">暂无图片</text></svg>');
}

/* ---------- 通用块 ---------- */
function headBar(){
  var auth = !!Persist.get(AUTH_KEY);
  var v = S.view;
  var brand = '<a class="brand" href="#" data-act="nav" data-view="home" aria-label="接力绘 首页">'
    + '<svg class="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">'
    + '<path d="M8.5 26.5c-3.2-8.6 4.6-17 13.6-17 6.8 0 11.4 4 11.4 9.3 0 6.6-7.6 11.4-15.6 11.4-4 0-7.6-1.1-9.4-3.7" stroke="#15101A" stroke-width="2.6" stroke-linecap="round"/>'
    + '<path d="M24.6 8.8l5.4 3.9-9.2 12.1-6.2 2.2 3.1-6.2z" fill="#FF3D6E" stroke="#15101A" stroke-width="1.7" stroke-linejoin="round"/>'
    + '</svg>'
    + '<span><span class="brand-name">接力绘</span><span class="brand-sub">RELAY DRAWING CLUB</span></span></a>';
  var nav = '<nav class="nav">'
    + '<a class="nav-link' + (v === 'home' ? ' is-on' : '') + '" href="#" data-act="nav" data-view="home">本期接龙</a>'
    + '<a class="nav-link' + (v === 'gallery' ? ' is-on' : '') + '" href="#" data-act="nav" data-view="gallery">作品馆</a>'
    + '<span class="nav-sep"></span>'
    + '<button class="entry" data-act="' + (auth ? 'go-admin' : 'login') + '">' + ICON.lock + '<span>' + (auth ? '管理后台' : '管理员登录') + '</span></button>'
    + '</nav>';
  return '<header class="site-head"><div class="wrap head-in">' + brand + nav + '</div></header>';
}

function footBar(){
  return '<footer class="foot"><div class="wrap foot-in">'
    + '<div class="foot-huge">下一棒<br><span>等你</span></div>'
    + '<div class="foot-grid">'
    + '<div><h4>ABOUT</h4><p>接力绘是一个靠互相接住才画得完的绘画社群。一个人开第一棒，下一个人接着画，六棒之后没人知道这张图本来会是什么样子。</p></div>'
    + '<div><h4>ENTRY</h4>'
    + '<a href="#" data-act="nav" data-view="home">本期接龙</a>'
    + '<a href="#" data-act="nav" data-view="gallery">往期作品馆</a>'
    + '<a href="#" data-act="login">管理员登录</a></div>'
    + '<div><h4>STATUS</h4><p>' + (Persist.ok ? '当前为前端原型，所有接龙与报名数据保存在本机浏览器中，清除浏览器数据会重置。' : '当前为前端原型，运行在预览沙箱中，数据保存在本次会话内存里，刷新后回到示例数据。') + '</p><p style="margin-top:8px;opacity:.6">云端接口已预留，接入方式见 source 注释。</p></div>'
    + '</div>'
    + '<div class="foot-bot"><span>© 2026 接力绘 · RELAY DRAWING</span><span>FRONT-END PROTOTYPE</span></div>'
    + '</div></footer>';
}

/* ---------- 首页 ---------- */
function heroBlock(){
  var ev = activeEvent();
  var mine = ev ? getReg()[ev.id] : null;
  var pool = allWorks().filter(function(o){ return o.w && o.w.img; });
  // 每次重新渲染首页都重新洗牌，避免主页长期固定展示同几张作品。
  for(var pi=pool.length-1;pi>0;pi--){
    var pj=Math.floor(Math.random()*(pi+1));
    var tmp=pool[pi]; pool[pi]=pool[pj]; pool[pj]=tmp;
  }
  COLLAGE.pool = pool;
  COLLAGE.cursor = Math.min(3, pool.length);
  var pick = pool.slice(0,3);

  var collage = '';
  if(pick.length){
    var cells = ['c1','c2','c3'];
    collage = '<div class="collage" aria-hidden="' + (pick.length ? 'false' : 'true') + '">';
    pick.forEach(function(o, i){
      collage += '<figure class="' + cells[i] + '" data-collage-index="' + i + '">'
        + '<span class="tape"></span>'
        + '<img src="' + esc(o.w.img || autoImg()) + '" alt="' + esc(o.ev.no + ' 期作品：' + o.w.title) + '" loading="lazy">'
        + '<figcaption>第 ' + o.w.slot + ' 棒 · ' + esc(o.w.author) + ' · R' + pad2(o.ev.no) + '</figcaption>'
        + '</figure>';
    });
    collage += '</div>';
  }

  var tag, lede, primary, sticker;
  if(ev){
    var st = statusOf(ev);
    var taken = ev.slots.filter(function(s){ return s.name; }).length;
    var free = ev.slots.length - taken;
    var due = dueLine(ev);
    sticker = 'ROUND ' + pad2(ev.no) + ' · ' + st.label;
    tag = '<b>第 ' + pad2(ev.no) + ' 期</b><span class="hero-st ' + st.cls + '">' + st.label + ' · ' + taken + ' / ' + ev.slots.length + ' 棒</span>';

    if(ev.status === 'open'){
      lede = (mine
          ? '你已经认领了第 ' + mine.slot + ' 棒。接下来等管理员放出上一棒的图，画完交稿就行。需要取消或换棒，找管理员。'
          : '一个人画完第一棒，下一个人接着画下去。' + (free > 0 ? '现在还剩 ' + free + ' 个棒位没人认领。' : '名额已经满了，但还能继续往后加棒。'))
        + (due ? due + '。' : '');
      primary = '<button class="btn" data-act="go-slots">' + (mine ? '看看这一期' : '认领一个棒位') + ICON.arrow + '</button>';
    } else if(ev.status === 'ongoing'){
      lede = (mine
          ? '这一期已经开画，你的第 ' + mine.slot + ' 棒正在等上一棒的图。画完交给管理员，其他人的棒位在后台能看。'
          : '这一期已经开画，棒位全部锁定，不再接受新的报名。想画就等下一期开始招募。')
        + (due ? due + '。' : '');
      primary = '<button class="btn" data-act="go-slots">看看画到哪了' + ICON.arrow + '</button>';
    } else {
      lede = '这一期已经收官，' + (ev.works || []).length + ' 件作品都放进作品馆了。下一期的关键词还在管理员手里，先看看这一期被画成了什么样。';
      primary = '<button class="btn" data-act="goto-round" data-id="' + ev.id + '">看这一期作品' + ICON.arrow + '</button>';
    }
  } else {
    sticker = 'NEXT ROUND · 筹备中';
    tag = '<b>下一期筹备中</b><span>关键词还没定</span>';
    lede = '第一期还没开始，关键词还在管理员手里。发布之后这里会挂出棒位，认领一棒就能画。';
    primary = '<button class="btn" data-act="nav" data-view="gallery">进作品馆' + ICON.arrow + '</button>';
  }

  return '<section class="hero"><div class="wrap hero-grid">'
    + '<div>'
    + '<span class="sticker"><i></i>' + sticker + '</span>'
    + '<h1><span class="line"><span>一笔</span></span><span class="line"><span>换<em>一手</em></span></span></h1>'
    + '<div class="hero-tag">' + tag + '</div>'
    + '<p class="lede">' + lede + '</p>'
    + '<div class="hero-acts">' + primary
    + '<button class="btn btn-ghost" data-act="nav" data-view="gallery">先看往期</button></div>'
    + '</div>' + collage + '</div></section>';
}

function marqueeBlock(){
  var ev = activeEvent();
  var bits = [];
  if(ev){
    bits.push('第 ' + pad2(ev.no) + ' 期' + statusOf(ev).label);
    (ev.keywords || []).forEach(function(k){ bits.push(k); });
  }
  bits.push('六棒成一图', '报名不用注册', '每期一人一棒', '接着上一棒画');
  var unit = bits.map(function(t){ return '<span class="star">✦</span><span>' + esc(t) + '</span>'; }).join('');
  var track = '';
  for(var i = 0; i < 6; i++) track += unit;
  return '<div class="marquee"><div class="marquee-track">' + track + '</div></div>';
}

function statsBlock(){
  var ev = activeEvent();
  var taken = ev ? ev.slots.filter(function(s){ return s.name; }).length : 0;
  var total = ev ? ev.slots.length : 0;
  var closed = byNo().filter(function(e){ return e.status === 'closed'; }).length;
  var ongoing = byNo().filter(function(e){ return e.status === 'ongoing'; }).length;
  var works = allWorks().length;
  return '<div class="wrap"><div class="stats">'
    + '<div class="stat"><b>' + (ev ? taken + '/' + total : '—') + '</b><span>' + (ev ? '第 ' + pad2(ev.no) + ' 期已认领' : '本期已认领') + '</span></div>'
    + '<div class="stat"><b>' + pad2(closed) + '</b><span>已收官期数</span></div>'
    + '<div class="stat"><b>' + pad2(works) + '</b><span>作品馆藏品</span></div>'
    + '</div></div>';
}

function currentBlock(){
  var ev = activeEvent();
  if(!ev) return '';
  var st = statusOf(ev);
  var taken = ev.slots.filter(function(s){ return s.name; }).length;
  var free = ev.slots.length - taken;
  var chips = (ev.keywords || []).map(function(k){ return '<span class="chip">' + esc(k) + '</span>'; }).join('');
  var rules = (ev.rules || []).map(function(r, i){
    return '<div class="rule"><b>' + pad2(i+1) + '</b><p>' + esc(r) + '</p></div>';
  }).join('');
  var stateTxt;
  if(ev.status === 'open'){
    stateTxt = free > 0 ? '招募中 · 还剩 ' + free + ' 棒' : '招募中 · 名额已满，可继续加棒';
  } else if(ev.status === 'ongoing'){
    stateTxt = '进行中 · 已收 ' + (ev.works || []).length + ' / ' + ev.slots.length + ' 份';
  } else {
    stateTxt = '已收官 · ' + (ev.works || []).length + ' 件作品入馆';
  }
  var due = dueLine(ev);
  return '<section class="section" id="current"><div class="wrap">'
    + '<div class="sec-head"><div><div class="kicker">THIS ROUND</div><h2 class="sec-title">这一期在画什么</h2></div>'
    + '<p class="sec-note">关键词只是方向，画面归画的人。</p></div>'
    + '<div class="info-grid"><div>'
    + '<div class="round-big">' + pad2(ev.no) + '<sup>ROUND</sup></div>'
    + '<div class="round-state"><i class="' + st.cls + '"></i>' + stateTxt + '</div>'
    + (due ? '<div class="round-due">' + due + '</div>' : '')
    + '<div class="chips">' + chips + '</div>'
    + '<p class="detail-txt">' + esc(ev.detail) + '</p>'
    + '</div><div><div class="kicker" style="margin-bottom:12px">RULES</div><div class="rule-list">' + rules + '</div></div>'
    + '</div></div></section>';
}

function slotsBlock(){
  var ev = activeEvent();
  if(!ev) return '';
  var st = statusOf(ev);
  var reg = getReg()[ev.id] || null;
  var canSign = ev.status === 'open';
  var taken = ev.slots.filter(function(s){ return s.name; }).length;
  var full = taken >= ev.slots.length;
  var cards = ev.slots.map(function(s){
    var isTaken = !!s.name;
    var isMine = canSign && reg && reg.slot === s.no;
    var cls = 'slot ' + (isTaken ? 'slot--taken' : 'slot--empty')
      + (isMine ? ' slot--mine' : '') + (canSign ? '' : ' slot--off');
    var inner = '<div class="slot-top"><div class="slot-num">' + pad2(s.no) + '</div>'
      + '<div class="slot-meta">' + (isTaken ? 'TAKEN' : (canSign ? 'OPEN' : 'LOCKED')) + '</div></div>'
      + '<div class="slot-body">'
      + (isTaken
        ? '<div class="slot-name">' + esc(s.name) + (isMine ? ' <span class="pill">你</span>' : '') + '</div><div class="slot-time">' + esc(s.at || '') + '</div>'
        : '<div class="slot-cta"><span>' + (canSign ? '认领这一棒' : '空缺') + '</span>' + (canSign ? ICON.arrow : '') + '</div>')
      + '</div>';
    return (isTaken || !canSign)
      ? '<div class="' + cls + '">' + inner + '</div>'
      : '<button class="' + cls + '" data-act="open-signup" data-ev="' + ev.id + '" data-slot="' + s.no + '">' + inner + '</button>';
  }).join('');

  var notice = '';
  if(canSign && reg){
    notice = '<div class="notice">' + ICON.info + '<div>你已经认领了第 ' + reg.slot + ' 棒，名字是「' + esc(reg.name) + '」。同一期只能报一次；要取消或换棒，请联系管理员在后台操作。</div></div>';
  } else if(!canSign){
    notice = '<div class="notice notice--lock">' + ICON.info + '<div>'
      + (ev.status === 'ongoing'
        ? '这一期已经开画，棒位全部锁定，不再接受新报名。想参加的话等下一期开始招募。'
        : '这一期已经收官，棒位只作为记录保留，作品都在作品馆里。')
      + '</div></div>';
  }

  var foot = '';
  if(canSign){
    foot = full
      ? '<div class="slots-foot">' + (reg ? '' : '<button class="add-slot" data-act="add-slot" data-ev="' + ev.id + '">名额已满 · 加一棒接着报</button>')
        + '<span style="font-size:12.5px;color:var(--muted)">有人还想画，就往后接着加棒，棒数可以一直长。</span></div>'
      : '<div class="slots-foot"><span style="font-size:12.5px;color:var(--muted)">棒数不用按顺序报，看中哪一棒就选哪一棒。每期每人只能认领一次。</span></div>';
  }

  return '<section class="section" id="slots"><div class="wrap">'
    + '<div class="sec-head"><div><div class="kicker">SLOT BOARD</div><h2 class="sec-title">' + (canSign ? '认领一棒' : '棒位记录') + '</h2></div>'
    + '<p class="sec-note">已认领 ' + taken + ' / ' + ev.slots.length + ' 棒。' + (canSign ? '空着的棒位点一下就报。' : st.hint + '。') + '</p></div>'
    + notice + '<div class="slots">' + cards + '</div>' + foot
    + '</div></section>';
}

var FEAT = { timer:null, pool:[], i:0, paused:false };
var COLLAGE = { timer:null, pool:[], cursor:0, paused:false };

/* 每期收官后都会定一张最佳、一张变化最大，这里把所有期都收进池子随机翻 */
function featPool(){
  return byNo().filter(function(e){
    return (e.bestId && findWork(e, e.bestId)) || (e.changeId && findWork(e, e.changeId));
  });
}

function featCards(host){
  var best = host.bestId ? findWork(host, host.bestId) : null;
  var change = host.changeId ? findWork(host, host.changeId) : null;

  function media(w){
    return '<div class="feat-media">' + (w ? '<img src="' + esc(w.img) + '" alt="' + esc(w.title) + '" decoding="async">' : '') + '</div>';
  }
  function body(w, label, desc, ev){
    if(!w){
      return '<div class="feat-body"><div><span class="feat-label">' + label + '</span><h3>这一项还空着</h3><p>管理员会在每期收官后从作品里挑一张放进来。</p></div><div></div></div>';
    }
    return '<div class="feat-body"><div>'
      + '<span class="feat-label">' + label + '</span>'
      + '<h3>' + esc(w.title) + '</h3>'
      + '<p>' + esc(desc) + '</p></div>'
      + '<div><div class="feat-meta">第 ' + pad2(ev.no) + ' 期 · 第 ' + w.slot + ' 棒 · ' + esc(w.author) + '</div>'
      + '<a class="feat-link" href="#" data-act="goto-round" data-id="' + ev.id + '" style="margin-top:14px">看这一期' + ICON.arrow + '</a></div></div>';
  }

  return '<div class="feat feat-a">' + media(best)
      + body(best, '最佳成品 · BEST', '六棒里完成度最高的一张，通常也是收尾收得最稳的一棒。', host) + '</div>'
    + '<div class="feat feat-b">' + body(change, '变化最大 · BIGGEST JUMP', '和上一棒比，走得最远的那一张。接龙有意思的地方就在这儿。', host) + media(change) + '</div>';
}

function featureBlock(){
  var pool = featPool();
  if(!pool.length) return '';
  FEAT.pool = pool;
  FEAT.i = Math.floor(Math.random() * pool.length);
  var host = pool[FEAT.i];
  var multi = pool.length > 1;
  return '<section class="section"><div class="wrap">'
    + '<div class="sec-head"><div><div class="kicker">HIGHLIGHTS</div><h2 class="sec-title">每期挑两张</h2></div>'
    + '<div class="sec-side"><p class="sec-note">一张最好，一张变化最大。每期收官后由管理员定，这里随机翻着看。</p>'
    + (multi ? '<button class="btn btn-ghost btn-sm" data-act="feat-next">换一组 ↻</button>' : '')
    + '</div></div>'
    + '<div class="feat-stack" id="featStack" data-round="' + pad2(host.no) + '">' + featCards(host) + '</div>'
    + '</div></section>';
}

function stopCollageCycle(){
  if(COLLAGE.timer){ clearInterval(COLLAGE.timer); COLLAGE.timer=null; }
}
function startCollageCycle(){
  stopCollageCycle();
  var box=document.querySelector('.collage');
  if(!box || COLLAGE.pool.length<2) return;
  box.addEventListener('mouseenter',function(){ COLLAGE.paused=true; });
  box.addEventListener('mouseleave',function(){ COLLAGE.paused=false; });
  COLLAGE.timer=setInterval(function(){
    var current=document.querySelector('.collage');
    if(!current){ stopCollageCycle(); return; }
    if(COLLAGE.paused || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var figures=current.querySelectorAll('figure');
    if(!figures.length) return;
    // 每轮给三张卡片分配不同作品，避免同一轮出现重复图。
    var available=COLLAGE.pool.slice();
    for(var i=available.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=available[i]; available[i]=available[j]; available[j]=t; }
    Array.prototype.forEach.call(figures,function(fig,index){
      var item=available[index]; if(!item) return;
      var img=fig.querySelector('img'), cap=fig.querySelector('figcaption');
      if(img){ img.style.opacity='0'; setTimeout(function(){ img.src=item.w.img || autoImg(); img.alt=item.ev.no+' 期作品：'+item.w.title; img.style.opacity='1'; },180); }
      if(cap) cap.textContent='第 '+item.w.slot+' 棒 · '+item.w.author+' · R'+pad2(item.ev.no);
    });
  },5000);
}

function stopFeatCycle(){
  if(FEAT.timer){ clearInterval(FEAT.timer); FEAT.timer = null; }
}

function stepFeat(){
  var el = document.getElementById('featStack');
  if(!el || FEAT.pool.length < 2) return;
  FEAT.i = (FEAT.i + 1) % FEAT.pool.length;
  el.classList.add('is-swap');
  setTimeout(function(){
    var node = document.getElementById('featStack');
    if(!node) return;
    node.innerHTML = featCards(FEAT.pool[FEAT.i]);
    node.setAttribute('data-round', pad2(FEAT.pool[FEAT.i].no));
    node.classList.remove('is-swap');
  }, 300);
}

function startFeatCycle(){
  stopFeatCycle();
  var stack = document.getElementById('featStack');
  if(!stack || FEAT.pool.length < 2) return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  stack.addEventListener('mouseenter', function(){ FEAT.paused = true; });
  stack.addEventListener('mouseleave', function(){ FEAT.paused = false; });
  FEAT.timer = setInterval(function(){
    if(FEAT.paused) return;
    var el = document.getElementById('featStack');
    if(!el){ stopFeatCycle(); return; }
    var r = el.getBoundingClientRect();
    if(r.bottom < 40 || r.top > window.innerHeight - 40) return;
    stepFeat();
  }, 7000);
}

function archiveBlock(){
  var list = byNo();
  if(!list.length) return '';
  var rows = list.map(function(ev){
    return '<a class="arch-row" href="#" data-act="goto-round" data-id="' + ev.id + '">'
      + '<div class="arch-no">' + pad2(ev.no) + '</div>'
      + '<div class="arch-kw">' + esc((ev.keywords || [])[0] || '未命名一期') + '<em>' + esc(ev.date || '') + '</em></div>'
      + '<div class="arch-desc">' + esc((ev.detail || '').slice(0, 42)) + (ev.detail && ev.detail.length > 42 ? '…' : '') + '</div>'
      + '<div class="arch-count"><span class="st ' + statusOf(ev).cls + '">' + statusOf(ev).label + '</span>' + (ev.works || []).length + ' 件 / ' + (ev.slots || []).length + ' 棒</div>'
      + ICON.arrow + '</a>';
  }).join('');
  return '<section class="section"><div class="wrap">'
    + '<div class="sec-head"><div><div class="kicker">ARCHIVE</div><h2 class="sec-title">往期都在这儿</h2></div>'
    + '<button class="btn btn-ghost btn-sm" data-act="nav" data-view="gallery">全部作品' + ICON.arrow + '</button></div>'
    + '<div class="arch-list">' + rows + '</div>'
    + '</div></section>';
}

function homeView(){
  return '<main>' + heroBlock() + marqueeBlock() + '<div style="padding-top:clamp(14px,2vw,22px)"></div>'
    + statsBlock() + currentBlock() + slotsBlock() + featureBlock() + archiveBlock() + '</main>';
}

/* ---------- 作品馆 ---------- */
function workCard(o){
  var ev = o.ev, w = o.w;
  return '<button class="work" data-act="lb" data-ev="' + ev.id + '" data-w="' + w.id + '">'
    + '<figure><img src="' + esc(w.img) + '" alt="第 ' + ev.no + ' 期第 ' + w.slot + ' 棒：' + esc(w.title) + '，作者 ' + esc(w.author) + '" loading="lazy">'
    + '<span class="badge">SLOT ' + pad2(w.slot) + '</span>'
    + '<span class="zoom">' + ICON.zoom + '</span></figure>'
    + '<div class="cap"><b>' + esc(w.title) + '</b><span>' + esc(w.author) + '</span></div>'
    + '</button>';
}

function specialCard(ev, id, kind){
  var w = id ? findWork(ev, id) : null;
  if(!w) return '';
  var isBest = kind === 'best';
  return '<div class="sp' + (isBest ? ' is-best' : '') + '">'
    + '<figure><img src="' + esc(w.img) + '" alt="' + esc(w.title) + '" loading="lazy"></figure>'
    + '<div><span class="tag">' + (isBest ? '最佳成品 BEST' : '变化最大 JUMP') + '</span>'
    + '<h4>' + esc(w.title) + '</h4>'
    + '<p>第 ' + w.slot + ' 棒 · ' + esc(w.author) + '</p></div></div>';
}

function galleryView(){
  var list = byNo();
  var total = allWorks().length;
  var side = list.map(function(ev){
    return '<a href="#r' + ev.no + '"><i class="st-dot ' + statusOf(ev).cls + '"></i>第 ' + pad2(ev.no) + ' 期<span>' + (ev.works || []).length + '</span></a>';
  }).join('');

  var rounds = list.map(function(ev){
    var sp = (ev.bestId || ev.changeId)
      ? '<div class="special">' + specialCard(ev, ev.bestId, 'best') + specialCard(ev, ev.changeId, 'change') + '</div>'
      : '';
    var works = (ev.works || []).length
      ? '<div class="works">' + ev.works.map(function(w){ return workCard({ ev:ev, w:w }); }).join('') + '</div>'
      : '<div class="empty">这一期还没有放出作品。</div>';
    return '<section class="round" id="r' + ev.no + '">'
      + '<div class="round-head"><div class="no"><small>ROUND</small>' + pad2(ev.no) + '</div>'
      + '<div class="kw">' + (ev.keywords || []).map(function(k){ return '<span>' + esc(k) + '</span>'; }).join('') + '</div>'
      + '<div class="when"><span class="st ' + statusOf(ev).cls + '">' + statusOf(ev).label + '</span>' + esc(ev.date || '') + ' · ' + (ev.slots || []).length + ' 棒 · ' + (ev.works || []).length + ' 件</div></div>'
      + sp + works + '</section>';
  }).join('');

  return '<main><div class="wrap"><div class="page-head">'
    + '<div class="kicker">GALLERY</div>'
    + '<h1 class="page-title">作品馆</h1>'
    + '<p class="page-lede">每一期都是几个人接力画出来的。这里留着全部成品，也留着每期变化最大的那一棒——看看同一条线被接成了几个样子。共 ' + list.length + ' 期 / ' + total + ' 件。</p>'
    + '</div></div>'
    + '<div class="wrap"><div class="gal">'
    + '<aside class="gal-side"><h4>INDEX</h4>' + side + '</aside>'
    + '<div>' + rounds + '</div>'
    + '</div></div></main>';
}

function render(){
  stopCollageCycle();
  stopFeatCycle();
  var root = $('#app');
  if(!root) return;
  var html;
  if(S.view === 'admin'){ html = adminView(); }
  else {
    html = headBar() + (S.view === 'gallery' ? galleryView() : homeView()) + footBar();
  }
  root.innerHTML = html;
  afterRender();
}

function afterRender(){
  var nodes = document.querySelectorAll('main > section, .round, .gal-side');
  if(!('IntersectionObserver' in window)){
    Array.prototype.forEach.call(nodes, function(n){ n.classList.add('is-in'); });
    startFeatCycle();
    startCollageCycle();
    return;
  }
  if(afterRender.io) afterRender.io.disconnect();
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(en.isIntersecting){ en.target.classList.add('is-in'); en.target.classList.remove('will-reveal'); io.unobserve(en.target); }
    });
  }, { threshold:.1, rootMargin:'0px 0px -6% 0px' });
  afterRender.io = io;
  Array.prototype.forEach.call(nodes, function(n){
    if(n.getBoundingClientRect().top > window.innerHeight * .94){ n.classList.add('will-reveal'); io.observe(n); }
    else { n.classList.add('is-in'); }
  });
  startFeatCycle();
  startCollageCycle();
}
window.__relay.refresh = refresh;
window.__relay.render = render;
window.__relay.EVENTS = function(){ return EVENTS; };
window.__relay.byNo = byNo;
window.__relay.openEvent = openEvent;
window.__relay.allWorks = allWorks;
window.__relay.findWork = findWork;
window.__relay.pad2 = pad2;

/* ---------- 登录 ---------- */
function loginView(){
  return '<div class="login-wrap"><div class="login-card">'
    + '<span class="sticker"><i></i>ADMIN ONLY</span>'
    + '<h1 style="font-size:clamp(26px,5vw,34px);font-weight:900;margin-top:20px;line-height:1.1;letter-spacing:-.02em">管理员登录</h1>'
    + '<p style="font-size:13px;color:var(--muted);margin-top:10px;line-height:1.7">只有管理员能发布接龙、安排棒位和处理报名。游客填名字就能报名，不需要账号。</p>'
    + '<form id="loginForm" autocomplete="off" novalidate>'
    + '<label class="field"><span>账号 ACCOUNT</span><input type="text" name="acc" inputmode="numeric" placeholder="管理员账号"></label>'
    + '<label class="field"><span>密码 PASSWORD</span><input type="password" name="pwd" placeholder="管理密码"></label>'
    + '<div class="err" id="loginErr">账号或密码不对</div>'
    + '<div class="modal-acts"><button class="btn" type="submit">登 录' + ICON.arrow + '</button></div>'
    + '</form>'
    + '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center">'
    + '<button data-act="nav" data-view="home" style="font-size:12px;color:var(--muted);border-bottom:1px solid currentColor;padding-bottom:1px">回到前台</button>'
    + '<span style="font-size:10.5px;letter-spacing:.04em;color:var(--muted);white-space:nowrap">仅管理员可登录</span>'
    + '</div></div></div>';
}

/* ---------- 后台 ---------- */
function eventForm(ev){
  var isNew = !ev;
  var nextNo = byNo().reduce(function(m,e){ return Math.max(m, e.no); }, 0) + 1;
  var cur = isNew ? 'open' : ev.status;
  var su = isNew ? isoDay(7) : (ev.signupUntil || '');
  var runDays = 10;
  if(!isNew && ev.signupUntil && ev.workUntil){
    var a = new Date(ev.signupUntil + 'T00:00:00').getTime();
    var b = new Date(ev.workUntil + 'T00:00:00').getTime();
    if(!isNaN(a) && !isNaN(b)) runDays = Math.min(15, Math.max(7, Math.round((b - a) / DAY)));
  }
  function opt(v, note){
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + STATUS[v].label + '（' + note + '）</option>';
  }
  return '<div class="sticky-form"><h3>' + (isNew ? '新建一期接龙' : '编辑第 ' + pad2(ev.no) + ' 期') + '</h3>'
    + '<p style="font-size:12px;color:var(--muted);margin-bottom:4px">期数、关键词、详情、规则都可以自由设定；期限一到，状态会自动往下走。</p>'
    + '<form id="eventForm" data-id="' + (isNew ? '' : ev.id) + '">'
    + '<div class="form-grid">'
    + '<label class="field"><span>第几期 <i>*</i></span><input type="text" inputmode="numeric" name="no" value="' + (isNew ? nextNo : ev.no) + '"></label>'
    + '<label class="field"><span>状态</span><select name="status">'
      + opt('open','报名开放') + opt('ongoing','画手中，报名关闭') + opt('closed','已结束') + '</select></label>'
    + '<label class="field"><span>报名截止</span><input type="date" name="signupUntil" value="' + esc(su) + '"></label>'
    + '<label class="field"><span>进行中天数（7–15 天）</span><input type="number" min="7" max="15" step="1" name="runDays" value="' + runDays + '"></label>'
    + '<div class="field full"><div class="form-tip">' + ICON.info + '<span>报名截止当天结束后自动转为「进行中」，再往后推「进行中天数」自动转为「已收官」。交稿截止 = 报名截止 + 进行中天数，也可以随时手动切换状态。</span></div></div>'
    + '<label class="field full"><span>关键词（用逗号分开，建议 3 个）</span><input type="text" name="keywords" value="' + esc(isNew ? '' : (ev.keywords || []).join('，')) + '" placeholder="夏天最后一天，天台，一罐没开的汽水"></label>'
    + '<label class="field full"><span>接龙详情</span><textarea name="detail" rows="3" placeholder="这一期想画什么，交给后面的人一句话">' + esc(isNew ? '' : ev.detail) + '</textarea></label>'
    + '<label class="field full"><span>规则（一行一条）</span><textarea name="rules" rows="4" placeholder="每期每人只认领一个棒位">' + esc(isNew ? DEFAULT_RULES.join('\n') : (ev.rules || []).join('\n')) + '</textarea></label>'
    + (isNew ? '<label class="field"><span>初始棒数</span><input type="text" inputmode="numeric" name="slotCount" value="6"></label>'
      : '<div class="field"><span>当前棒数</span><div class="mono" style="padding:11px 0;font-size:15px">' + (ev.slots || []).length + ' 棒 · 已认领 ' + (ev.slots || []).filter(function(s){ return s.name; }).length + '</div></div>')
    + '</div>'
    + '<div class="modal-acts" style="margin-top:8px">'
    + '<button class="btn" type="submit">' + (isNew ? '发布这一期' : '保存修改') + ICON.arrow + '</button>'
    + '<button class="btn btn-ghost" type="button" data-act="adm-cancel">取消</button>'
    + '</div></form></div>';
}

function tabEvents(){
  var list = byNo();
  var editing = S.editId === 'new' ? null : list.filter(function(e){ return e.id === S.editId; })[0];
  var NEXT = { open:'ongoing', ongoing:'closed', closed:'open' };
  var rows = list.map(function(ev){
    var taken = (ev.slots || []).filter(function(s){ return s.name; }).length;
    var st = statusOf(ev);
    var win = '';
    if(ev.signupUntil || ev.workUntil){
      win = '报名至 ' + (ev.signupUntil ? ev.signupUntil.slice(5) : '—') + ' · 交稿至 ' + (ev.workUntil ? ev.workUntil.slice(5) : '—');
    }
    return '<div class="adm-row">'
      + '<div class="rn">' + pad2(ev.no) + '</div>'
      + '<div><div class="rt"><span class="st ' + st.cls + '">' + st.label + '</span>' + esc((ev.keywords || [])[0] || '未命名') + '</div>'
      + '<div class="rs">' + esc(ev.date || '') + ' · ' + taken + '/' + (ev.slots || []).length + ' 棒 · ' + (ev.works || []).length + ' 件作品' + (win ? ' · ' + win : '') + '</div></div>'
      + '<div class="ra">'
      + '<button class="mini" data-act="adm-edit" data-id="' + ev.id + '">编辑</button>'
      + '<button class="mini" data-act="adm-status" data-id="' + ev.id + '">转为' + STATUS[NEXT[ev.status] || 'open'].label + '</button>'
      + '<button class="mini" data-act="adm-addslot" data-id="' + ev.id + '">加一棒</button>'
      + '<button class="mini danger" data-act="adm-del" data-id="' + ev.id + '">删除</button>'
      + '</div></div>';
  }).join('');

  return '<div class="adm-top"><div><h2>接龙管理</h2><p>发布、修改、收尾。同一时间只有一期处于招募中，状态会按期限自动流转。</p></div>'
    + '<button class="btn btn-sm" data-act="adm-new">+ 新建一期</button></div>'
    + (S.editId ? eventForm(editing) : '')
    + '<div class="adm-cards">' + (rows || '<div class="empty">还没有任何一期，先新建一期吧。</div>') + '</div>';
}

function tabSignups(){
  var list = byNo();
  if(!list.length) return '<div class="adm-top"><div><h2>报名管理</h2></div></div><div class="empty">还没有接龙。</div>';
  var ev = list.filter(function(e){ return e.id === S.admEventId; })[0] || list[0];
  S.admEventId = ev.id;
  var opts = list.map(function(e){
    return '<option value="' + e.id + '"' + (e.id === ev.id ? ' selected' : '') + '>第 ' + pad2(e.no) + ' 期 · ' + esc((e.keywords || [])[0] || '未命名') + '</option>';
  }).join('');
  var rows = (ev.slots || []).map(function(s){
    var hasWork = (ev.works || []).some(function(w){ return w.slot === s.no; });
    return '<tr><td class="n">' + pad2(s.no) + '</td>'
      + '<td>' + (s.name ? esc(s.name) : '<span class="muted">空缺</span>') + '</td>'
      + '<td class="muted">' + esc(s.at || '—') + '</td>'
      + '<td><div class="tbl-acts">'
      + (s.name ? '<button class="mini" data-act="move-slot" data-ev="' + ev.id + '" data-slot="' + s.no + '">换棒</button>'
        + '<button class="mini danger" data-act="cancel-signup" data-ev="' + ev.id + '" data-slot="' + s.no + '">取消报名</button>' : '')
      + '<button class="mini" data-act="del-slot" data-ev="' + ev.id + '" data-slot="' + s.no + '" data-has="' + (hasWork ? '1' : '0') + '">删除棒位</button>'
      + '</div></td></tr>';
  }).join('');
  return '<div class="adm-top"><div><h2>报名管理</h2><p>游客不能自己改，取消和换棒都在这里做；删除棒位后，后面的棒位会自动前移补齐，序号不会断。</p></div>'
    + '<select data-act="pick-event" style="max-width:260px">' + opts + '</select></div>'
    + '<div class="scroll-x" style="margin-top:16px"><table class="tbl"><thead><tr><th>棒位</th><th>报名者</th><th>报名时间</th><th style="text-align:right">操作</th></tr></thead><tbody>'
    + rows + '</tbody></table></div>'
    + '<p style="font-size:12px;color:var(--muted);margin-top:12px">当前 ' + (ev.slots || []).length + ' 棒 · 已认领 ' + (ev.slots || []).filter(function(s){ return s.name; }).length + ' · 最多保留到第 ' + pad2((ev.slots || []).length) + ' 棒</p>';
}

function tabWorks(){
  var list = byNo();
  if(!list.length) return '<div class="adm-top"><div><h2>作品管理</h2></div></div><div class="empty">还没有接龙。</div>';
  var ev = list.filter(function(e){ return e.id === S.admEventId; })[0] || list[0];
  S.admEventId = ev.id;
  var opts = list.map(function(e){
    return '<option value="' + e.id + '"' + (e.id === ev.id ? ' selected' : '') + '>第 ' + pad2(e.no) + ' 期 · ' + esc((e.keywords || [])[0] || '未命名') + '</option>';
  }).join('');
  var cards = (ev.works || []).slice().sort(function(a,b){ return Number(a.slot)-Number(b.slot) || String(a.id).localeCompare(String(b.id)); }).map(function(w){
    return '<div class="wcard"><figure><img src="' + esc(w.img) + '" alt="' + esc(w.title) + '" loading="lazy"></figure>'
      + '<div class="wt">' + esc(w.title) + '</div><div class="ws">第 ' + w.slot + ' 棒 · ' + esc(w.author) + '</div>'
      + '<div class="wa"><button class="' + (ev.bestId === w.id ? 'on' : '') + '" data-act="set-best" data-ev="' + ev.id + '" data-w="' + w.id + '">最佳</button>'
      + '<button class="' + (ev.changeId === w.id ? 'on' : '') + '" data-act="set-change" data-ev="' + ev.id + '" data-w="' + w.id + '">变化</button>'
      + '<button data-act="swap-img" data-ev="' + ev.id + '" data-w="' + w.id + '">换图</button>'
      + '<button data-act="del-work" data-ev="' + ev.id + '" data-w="' + w.id + '">删</button></div></div>';
  }).join('');
  return '<div class="adm-top"><div><h2>作品管理</h2><p>每期一件最佳、一件变化最大，选中后会出现在首页与作品馆的专场里；画质不满意可以直接换图。</p></div>'
    + '<select data-act="pick-event" style="max-width:260px">' + opts + '</select></div>'
    + '<div class="sticky-form" style="margin-top:16px"><h3>往第 ' + pad2(ev.no) + ' 期加入作品</h3>'
    + '<form id="workForm" data-ev="' + ev.id + '"><div class="form-grid">'
    + '<label class="field"><span>作品名</span><input type="text" name="title" placeholder="给这张图起个名字"></label>'
    + '<label class="field"><span>作者</span><input type="text" name="author" placeholder="画的人"></label>'
    + '<label class="field"><span>第几棒</span><input type="text" inputmode="numeric" name="slot" value="1"></label>'
    + '<label class="field"><span>图片</span><input type="file" name="file" accept="image/*"></label>'
    + '</div><div class="modal-acts" style="margin-top:4px;justify-content:flex-start"><button class="btn" type="submit" style="flex:0 0 auto">加入这一期' + ICON.arrow + '</button></div></form></div>'
    + '<div class="work-grid">' + (cards || '<div class="empty" style="grid-column:1/-1">这一期还没有作品。</div>') + '</div>';
}

function adminView(){
  if(!Persist.get(AUTH_KEY)) return loginView();
  var list = byNo();
  var signups = list.reduce(function(n, e){ return n + (e.slots || []).filter(function(s){ return s.name; }).length; }, 0);
  var works = allWorks().length;
  var tab = S.tab || 'events';
  var body = tab === 'signups' ? tabSignups() : tab === 'works' ? tabWorks() : tabEvents();
  return '<div class="adm-head"><div class="adm-head-in">'
    + '<a class="brand" href="#" data-act="nav" data-view="home" aria-label="接力绘">'
    + '<svg class="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8.5 26.5c-3.2-8.6 4.6-17 13.6-17 6.8 0 11.4 4 11.4 9.3 0 6.6-7.6 11.4-15.6 11.4-4 0-7.6-1.1-9.4-3.7" stroke="#15101A" stroke-width="2.6" stroke-linecap="round"/><path d="M24.6 8.8l5.4 3.9-9.2 12.1-6.2 2.2 3.1-6.2z" fill="#FF3D6E" stroke="#15101A" stroke-width="1.7" stroke-linejoin="round"/></svg>'
    + '<span class="brand-name">接力绘</span></a>'
    + '<span class="adm-tag">ADMIN</span>'
    + '<div style="margin-left:auto;display:flex;gap:8px;align-items:center">'
    + '<button class="mini" data-act="nav" data-view="home">回到前台</button>'
    + '<button class="mini danger" data-act="logout">退出登录</button></div>'
    + '</div></div>'
    + '<div class="adm-body"><aside class="adm-side">'
    + '<div class="who">SIGNED IN<br>ADMIN</div>'
    + '<button class="adm-tab' + (tab === 'events' ? ' is-on' : '') + '" data-act="adm-tab" data-tab="events">接龙管理<em>' + pad2(list.length) + '</em></button>'
    + '<button class="adm-tab' + (tab === 'signups' ? ' is-on' : '') + '" data-act="adm-tab" data-tab="signups">报名管理<em>' + pad2(signups) + '</em></button>'
    + '<button class="adm-tab' + (tab === 'works' ? ' is-on' : '') + '" data-act="adm-tab" data-tab="works">作品管理<em>' + pad2(works) + '</em></button>'
    + '<div class="adm-status mono" style="margin-top:22px;padding-top:14px;border-top:1px solid rgba(252,249,242,.16);font-size:10.5px;line-height:1.7;color:rgba(252,249,242,.42)">'
    + (Persist.ok ? 'STORAGE: LOCAL' : 'STORAGE: MEMORY') + '<br>API: ' + (CFG.mode === 'remote' ? 'REMOTE' : 'LOCAL') + '</div>'
    + '</aside><main class="adm-main">' + body + '</main></div>';
}
/* ---------- 交互 ---------- */
var DEFAULT_RULES = [
  '每期每人只认领一个棒位，认领后不能自己改，需要取消或换棒请找管理员。',
  '拿到上一棒的图之后，接着这张画下去，不要重画整体构图。',
  '交稿窗口 72 小时，最短边不小于 1600px，PNG 或 JPG 都行。',
  '关键词必须出现在画面里，但不要求写得直白。',
  '第六棒收尾后，管理员会把成品、最佳成品和变化最大的一棒一起放进作品馆。'
];
var toastTimer = null;
function toast(msg){
  var el = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('is-on'); }, 2800);
}
function showErr(id, msg){
  var el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg;
  el.classList.add('is-on');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
function openModal(html){
  var m = document.getElementById('modal');
  document.getElementById('modalCard').innerHTML = html;
  m.classList.add('is-on');
  m.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  setTimeout(function(){
    var f = document.querySelector('#modalCard input:not([type=file]), #modalCard textarea');
    if(f && window.innerWidth > 620) f.focus();
  }, 280);
}
function closeModal(){
  var m = document.getElementById('modal');
  m.classList.remove('is-on');
  m.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}
function confirmAction(title, desc, fn){
  S.pending = fn;
  openModal('<button class="modal-x" data-act="modal-close" aria-label="关闭">' + ICON.close + '</button>'
    + '<div class="modal-kicker">CONFIRM</div>'
    + '<h3 class="modal-title">' + esc(title) + '</h3>'
    + '<p class="modal-sub">' + esc(desc) + '</p>'
    + '<div class="modal-acts"><button class="btn" data-act="confirm-yes">确定</button>'
    + '<button class="btn btn-ghost" data-act="modal-close">取消</button></div>');
}

function openSignup(evId, slotNo){
  var ev = EVENTS.filter(function(e){ return e.id === evId; })[0];
  if(!ev) return;
  var reg = getReg()[evId];
  if(reg){ toast('这一期你已经报过了，要改请找管理员'); return; }
  var slot = (ev.slots || []).filter(function(s){ return s.no === slotNo; })[0];
  if(!slot){ toast('这个棒位没了'); return; }
  if(slot.name){ toast('第 ' + slotNo + ' 棒刚被认领了'); refresh().then(render); return; }
  openModal('<button class="modal-x" data-act="modal-close" aria-label="关闭">' + ICON.close + '</button>'
    + '<div class="modal-kicker">ENTER THE RELAY</div>'
    + '<h3 class="modal-title">认领第 ' + pad2(slotNo) + ' 棒</h3>'
    + '<p class="modal-sub">第 ' + pad2(ev.no) + ' 期 · ' + esc((ev.keywords || [])[0] || '未命名一期') + '。填个名字就能报，不用注册账号。</p>'
    + '<div class="picked"><b>' + pad2(slotNo) + '</b><span>SLOT ' + pad2(slotNo) + ' / ' + pad2((ev.slots || []).length) + '<br>你只需要交出这一个棒位</span></div>'
    + '<form id="signupForm" data-ev="' + evId + '" data-slot="' + slotNo + '" novalidate>'
    + '<label class="field"><span>你的名字 <i>*</i></span><input type="text" name="name" maxlength="18" placeholder="让后面接棒的人知道是谁画的" autocomplete="nickname"></label>'
    + '<div class="err" id="signupErr"></div>'
    + '<div class="modal-acts"><button class="btn" type="submit">确认认领' + ICON.arrow + '</button>'
    + '<button class="btn btn-ghost" type="button" data-act="modal-close">再想想</button></div>'
    + '<p class="hint">同一期每人只能报一次。报完想换棒或者退出，找管理员在后台处理。</p>'
    + '</form>');
}

function moveModal(evId, from){
  var ev = EVENTS.filter(function(e){ return e.id === evId; })[0];
  if(!ev) return;
  var free = (ev.slots || []).filter(function(s){ return !s.name && s.no !== from; });
  if(!free.length){ toast('这一期没有空位可以换'); return; }
  var src = (ev.slots || []).filter(function(s){ return s.no === from; })[0];
  var btns = free.map(function(s){
    return '<button class="mini" style="flex:1;padding:10px 4px;font-family:var(--mono);font-size:13px" data-act="do-move" data-ev="' + evId + '" data-from="' + from + '" data-to="' + s.no + '">' + pad2(s.no) + '</button>';
  }).join('');
  openModal('<button class="modal-x" data-act="modal-close" aria-label="关闭">' + ICON.close + '</button>'
    + '<div class="modal-kicker">MOVE SLOT</div>'
    + '<h3 class="modal-title">把「' + esc(src ? src.name : '') + '」换到哪一棒</h3>'
    + '<p class="modal-sub">第 ' + pad2(ev.no) + ' 期 · 现在在第 ' + pad2(from) + ' 棒。换棒后原棒位会空出来。</p>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">' + btns + '</div>');
}

function readImg(file){
  return new Promise(function(resolve, reject){
    if(!file) return reject(new Error('没有选择图片'));
    if(!/^image\//i.test(file.type || '')) return reject(new Error('请选择 JPG、PNG 或 WebP 图片'));
    if(file.size > 20 * 1024 * 1024) return reject(new Error('原图超过 20MB，请先缩小图片'));
    var objectUrl = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function(){
      try{
        var max = 1400, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if(!w || !h) throw new Error('无法读取图片尺寸');
        if(Math.max(w, h) > max){ var ratio = max / Math.max(w, h); w = Math.max(1, Math.round(w * ratio)); h = Math.max(1, Math.round(h * ratio)); }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        if(!ctx) throw new Error('当前浏览器无法创建图片画布');
        ctx.fillStyle = '#F3EEE4'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        if(!canvas.toBlob) throw new Error('当前浏览器不支持图片压缩，请更新浏览器');
        canvas.toBlob(function(blob){
          URL.revokeObjectURL(objectUrl);
          if(!blob || !blob.size) return reject(new Error('图片压缩失败，画布没有生成有效文件'));
          resolve(blob);
        }, 'image/jpeg', 0.78);
      }catch(error){ URL.revokeObjectURL(objectUrl); reject(error); }
    };
    img.onerror = function(){ URL.revokeObjectURL(objectUrl); reject(new Error('图片解码失败，请换一张图片'));
    };
    img.src = objectUrl;
  });
}

/* lightbox */
function openLb(evId, workId){
  var ev = EVENTS.filter(function(e){ return e.id === evId; })[0];
  if(!ev) return;
  var arr = (ev.works || []).slice();
  var idx = -1;
  arr.forEach(function(w, i){ if(w.id === workId) idx = i; });
  if(idx < 0) return;
  S.lbList = arr.map(function(w){
    return { img:w.img, title:w.title, meta:'第 ' + pad2(ev.no) + ' 期 · 第 ' + w.slot + ' 棒 · ' + w.author };
  });
  S.lbIndex = idx;
  paintLb();
  var lb = document.getElementById('lb');
  lb.classList.add('is-on');
  lb.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
}
function paintLb(){
  var o = S.lbList[S.lbIndex];
  if(!o) return;
  document.getElementById('lbImg').src = o.img;
  document.getElementById('lbImg').alt = o.title;
  document.getElementById('lbTitle').textContent = o.title;
  document.getElementById('lbMeta').textContent = o.meta + '　' + (S.lbIndex + 1) + '/' + S.lbList.length;
}
var lbStep = function(d){
  if(!S.lbList || !S.lbList.length) return;
  S.lbIndex = (S.lbIndex + d + S.lbList.length) % S.lbList.length;
  paintLb();
};
function closeLb(){
  var lb = document.getElementById('lb');
  lb.classList.remove('is-on');
  lb.setAttribute('aria-hidden','true');
  document.body.style.overflow = '';
}

/* ---------- 事件委托 ---------- */
document.addEventListener('click', function(e){
  var el = e.target.closest ? e.target.closest('[data-act]') : null;
  if(!el) return;
  var act = el.getAttribute('data-act');
  var evId = el.getAttribute('data-ev');
  if(['adm-status','adm-addslot','add-slot','do-move','set-best','set-change','confirm-yes'].indexOf(act) >= 0 && !el.disabled){
    setBusy(el, act === 'confirm-yes' ? '正在执行…' : '处理中…');
  }
  var slot = parseInt(el.getAttribute('data-slot'), 10);
  var id = el.getAttribute('data-id');

  if(act === 'nav' || act === 'login'){
    e.preventDefault();
    S.view = (act === 'login') ? 'admin' : el.getAttribute('data-view');
    S.editId = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if(act === 'go-slots'){
    e.preventDefault();
    var s = document.getElementById('slots');
    if(s) s.scrollIntoView({ behavior:'smooth', block:'start' });
    return;
  }
  if(act === 'goto-round'){
    e.preventDefault();
    var target = EVENTS.filter(function(x){ return x.id === id; })[0];
    S.view = 'gallery';
    render();
    window.scrollTo(0, 0);
    if(target){
      setTimeout(function(){
        var node = document.getElementById('r' + target.no);
        if(node) node.scrollIntoView({ behavior:'smooth', block:'start' });
      }, 90);
    }
    return;
  }
  if(act === 'go-admin'){ S.view = 'admin'; S.tab = 'events'; render(); window.scrollTo(0,0); return; }
  if(act === 'logout'){
    Promise.resolve(API.signOutAdmin()).then(function(){
      Persist.del(AUTH_KEY); S.view = 'home'; S.editId = null;
      return refresh();
    }).then(function(){ render(); toast('已退出登录'); window.scrollTo(0,0); })
      .catch(function(err){ toast(err.message || '退出登录失败'); });
    return;
  }
  if(act === 'adm-tab'){ S.tab = el.getAttribute('data-tab'); render(); return; }
  if(act === 'adm-new'){ S.editId = 'new'; render(); var f = document.querySelector('.sticky-form'); if(f) f.scrollIntoView({behavior:'smooth', block:'center'}); return; }
  if(act === 'adm-edit'){ S.editId = id; render(); var g = document.querySelector('.sticky-form'); if(g) g.scrollIntoView({behavior:'smooth', block:'center'}); return; }
  if(act === 'adm-cancel'){ S.editId = null; render(); return; }
  if(act === 'adm-status'){
    var evz = EVENTS.filter(function(x){ return x.id === id; })[0];
    if(!evz) return;
    var nxt = { open:'ongoing', ongoing:'closed', closed:'open' }[evz.status] || 'open';
    Promise.resolve(API.updateEvent(id, { status: nxt }))
      .then(refresh).then(function(){ render(); toast('第 ' + pad2(evz.no) + ' 期已设为' + STATUS[nxt].label); }).catch(function(err){ clearAllBusy(); toast(err.message || '状态修改失败'); });
    return;
  }
  if(act === 'adm-addslot'){
    Promise.resolve(API.addSlot(id)).then(function(no){ return refresh().then(function(){ render(); toast('加好了，现在是第 ' + no + ' 棒'); }); }).catch(function(err){ clearAllBusy(); toast(err.message || '添加棒位失败'); });
    return;
  }
  if(act === 'adm-del'){
    var de = EVENTS.filter(function(x){ return x.id === id; })[0];
    confirmAction('删掉第 ' + pad2(de ? de.no : 0) + ' 期？', '这一期的关键词、棒位和作品会一起消失，删掉之后找不回来。', function(){
      Promise.resolve(API.deleteEvent(id)).then(function(){
        if(S.admEventId === id) S.admEventId = '';
        return refresh();
      }).then(function(){ render(); toast('已删除'); }).catch(function(err){ clearAllBusy(); toast(err.message || '删除失败'); });
    });
    return;
  }
  if(act === 'open-signup'){ e.preventDefault(); openSignup(evId, slot); return; }
  if(act === 'add-slot'){
    Promise.resolve(API.addSlot(evId)).then(function(no){
      return refresh().then(function(){ render(); openSignup(evId, no); });
    });
    return;
  }
  if(act === 'cancel-signup'){
    confirmAction('取消第 ' + pad2(slot) + ' 棒的报名？', '取消后棒位会空出来，别人可以认领。', function(){
      Promise.resolve(API.cancelSignup(evId, slot)).then(refresh).then(function(){ render(); toast('已取消，棒位空出来了'); }).catch(function(err){ clearAllBusy(); toast(err.message || '取消报名失败'); });
    });
    return;
  }
  if(act === 'move-slot'){ moveModal(evId, slot); return; }
  if(act === 'feat-next'){ e.preventDefault(); stepFeat(); return; }
  if(act === 'del-slot'){
    e.preventDefault();
    var slotNo2 = parseInt(el.getAttribute('data-slot'), 10);
    var hasWork = el.getAttribute('data-has') === '1';
    var evd = EVENTS.filter(function(x){ return x.id === evId; })[0];
    var occ = evd ? evd.slots.filter(function(x){ return x.no === slotNo2; })[0] : null;
    var desc = '删掉第 ' + pad2(slotNo2) + ' 棒之后，后面的棒位会自动前移补位，序号重新排，不会断号。'
      + (occ && occ.name ? '这一棒现在是「' + occ.name + '」，报名会一起清掉。' : '')
      + (hasWork ? '这一棒的作品也会从作品馆里一起删掉。' : '');
    confirmAction('删掉第 ' + pad2(slotNo2) + ' 棒？', desc, function(){
      Promise.resolve().then(function(){ return API.removeSlot(evId, slotNo2); })
        .then(function(r){ return refresh().then(function(){ return r; }); })
        .then(function(r){
          render();
          toast('已删除第 ' + pad2(slotNo2) + ' 棒，后面自动补位' + (r && r.dropped ? '，同时删掉 ' + r.dropped + ' 件作品' : ''));
        })
        .catch(function(err){ toast(err.message || '删除失败'); });
    });
    return;
  }
  if(act === 'swap-img'){
    e.preventDefault();
    var widx = el.getAttribute('data-w');
    var evw = evId;
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.addEventListener('change', function(){
      var file = picker.files && picker.files[0];
      if(!file) return;
      toast('正在处理图片…');
      readImg(file).then(function(src){
        return Promise.resolve(API.updateWork(evw, widx, { img: src }));
      }).then(function(){ return refresh(); })
        .then(function(){ render(); toast('图片换好了'); })
        .catch(function(err){ console.error('[接力绘] 换图失败', err); toast(err.message || '换图失败，请稍后重试'); });
    });
    picker.click();
    return;
  }
  if(act === 'do-move'){
    var to = parseInt(el.getAttribute('data-to'), 10);
    var from = parseInt(el.getAttribute('data-from'), 10);
    Promise.resolve().then(function(){ return API.moveSlot(evId, from, to); })
      .then(refresh).then(function(){ closeModal(); render(); toast('已换到第 ' + pad2(to) + ' 棒'); })
      .catch(function(err){ clearAllBusy(); toast(err.message || '换棒失败'); });
    return;
  }
  if(act === 'set-best' || act === 'set-change'){
    Promise.resolve(API.setSpecial(evId, el.getAttribute('data-w'), act === 'set-best' ? 'best' : 'change'))
      .then(refresh).then(function(){
        render();
        var ev2 = EVENTS.filter(function(x){ return x.id === evId; })[0];
        var on = ev2 && (act === 'set-best' ? ev2.bestId : ev2.changeId) === el.getAttribute('data-w');
        toast(on ? '已设为' + (act === 'set-best' ? '最佳成品' : '变化最大') : '已取消这个标记');
      }).catch(function(err){ clearAllBusy(); toast(err.message || '精选标记更新失败'); });
    return;
  }
  if(act === 'del-work'){
    var wid = el.getAttribute('data-w');
    confirmAction('删掉这张作品？', '删掉后会从作品馆和精选里一起消失。', function(){
      Promise.resolve(API.deleteWork(evId, wid)).then(refresh).then(function(){ render(); toast('已删除'); }).catch(function(err){ clearAllBusy(); toast(err.message || '删除作品失败'); });
    });
    return;
  }
  if(act === 'lb'){ openLb(evId, el.getAttribute('data-w')); return; }
  if(act === 'lb-close'){ closeLb(); return; }
  if(act === 'lb-prev'){ lbStep(-1); return; }
  if(act === 'lb-next'){ lbStep(1); return; }
  if(act === 'modal-close'){ closeModal(); return; }
  if(act === 'confirm-yes'){ var fn = S.pending; S.pending = null; closeModal(); if(fn) fn(); return; }
});

document.addEventListener('change', function(e){
  var el = e.target;
  if(el.getAttribute && el.getAttribute('data-act') === 'pick-event'){
    S.admEventId = el.value; render();
  }
});

document.addEventListener('submit', function(e){
  var f = e.target;
  if(f.id === 'loginForm'){
    e.preventDefault();
    var acc = (f.acc.value || '').trim();
    var pwd = (f.pwd.value || '').trim();
    setBusy(f.querySelector('button[type="submit"]'), '正在登录…');
    API.signInAdmin(acc, pwd).then(function(){
      S.tab = 'events'; S.editId = null;
      return refresh();
    }).then(function(){
      render(); window.scrollTo(0, 0); toast('欢迎回来');
    }).catch(function(err){
      clearAllBusy();
      showErr('loginErr', err.message || '账号或密码不对，再试一次');
    });
    return;
  }
  if(f.id === 'signupForm'){
    e.preventDefault();
    var evId = f.getAttribute('data-ev');
    var slot = parseInt(f.getAttribute('data-slot'), 10);
    var name = (f.name.value || '').trim();
    if(!name){ showErr('signupErr', '先填个名字，后面的人好知道是谁接的'); return; }
    if(name.length > 18){ showErr('signupErr', '名字太长了，18 个字以内'); return; }
    setBusy(f.querySelector('button[type="submit"]'), '正在提交报名…');
    Promise.resolve().then(function(){ return API.signup(evId, slot, name); })
      .then(function(){ return refresh(); })
      .then(function(){ closeModal(); render(); toast('报上了，第 ' + pad2(slot) + ' 棒是你的了'); })
      .catch(function(err){ clearAllBusy(); showErr('signupErr', err.message || '报名失败，稍后再试'); });
    return;
  }
  if(f.id === 'eventForm'){
    e.preventDefault();
    var id = f.getAttribute('data-id');
    var no = parseInt((f.no.value || '').trim(), 10);
    if(!no || no < 1){ toast('期数要填一个数字'); return; }
    var kws = (f.keywords.value || '').split(/[,，、\s]+/).filter(Boolean);
    var rules = (f.rules.value || '').split('\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var status = f.status.value;
    var su = (f.signupUntil.value || '').trim();
    var rd = parseInt(f.runDays.value, 10);
    if(isNaN(rd)) rd = 10;
    rd = Math.min(15, Math.max(7, rd));
    if(status !== 'closed' && !su){ toast('先选一个报名截止日期'); return; }
    var payload = {
      no: no, keywords: kws, detail: (f.detail.value || '').trim(),
      rules: rules, status: status,
      signupUntil: su,
      workUntil: su ? addDays(su, rd) : ''
    };
    if(!id){ payload.slotCount = Math.max(1, parseInt(f.slotCount.value, 10) || 6); }
    setBusy(f.querySelector('button[type="submit"]'), id ? '正在保存…' : '正在发布接龙…');
    Promise.resolve().then(function(){
      return id ? API.updateEvent(id, payload) : API.createEvent(payload);
    }).then(function(){ S.editId = null; return refresh(); })
      .then(function(){ render(); toast(id ? '已保存' : '第 ' + pad2(no) + ' 期发出去了'); })
      .catch(function(err){ clearAllBusy(); toast(err.message || '保存失败'); });
    return;
  }
  if(f.id === 'workForm'){
    e.preventDefault();
    var evId2 = f.getAttribute('data-ev');
    var title = (f.title.value || '').trim() || '未命名';
    var author = (f.author.value || '').trim() || '匿名';
    var slot2 = Math.max(1, parseInt(f.slot.value, 10) || 1);
    var file = f.file.files && f.file.files[0];
    var step = file ? readImg(file) : Promise.resolve(autoImg());
    setBusy(f.querySelector('button[type="submit"]'), '正在加入作品…');
    step.then(function(src){
      return API.addWork(evId2, { title:title, author:author, slot:slot2, img:src, at:new Date().toISOString().slice(5,10) });
    }).then(function(){ return refresh(); })
      .then(function(){ render(); toast('作品已加入'); })
      .catch(function(err){ clearAllBusy(); console.error('[接力绘] 作品上传失败', err); toast(err.message || '图片处理或上传失败，请稍后重试'); });
    return;
  }
});

document.addEventListener('keydown', function(e){
  var lb = document.getElementById('lb');
  var open = lb.classList.contains('is-on');
  if(e.key === 'Escape'){ if(open) closeLb(); else closeModal(); return; }
  if(open){
    if(e.key === 'ArrowRight'){ e.preventDefault(); lbStep(1); }
    if(e.key === 'ArrowLeft'){ e.preventDefault(); lbStep(-1); }
  }
});

document.getElementById('lb').addEventListener('click', function(e){ if(e.target === this) closeLb(); });
document.getElementById('modal').addEventListener('click', function(e){ if(e.target === this) closeModal(); });

/* ---------- 启动 ---------- */
refresh().then(render).catch(function(){ render(); });
})();