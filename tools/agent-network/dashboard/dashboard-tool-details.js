/* Admin-only MCP tool call input inspector.
 * Arguments are already redacted before SQLite storage. We render untrusted
 * JSON exclusively with textContent (never HTML or Markdown).
 */
(() => {
  const $=id=>document.getElementById(id);
  const state={callId:null,generation:0,previousFocus:null,raw:''};
  const visible=()=>!$('tool-call-overlay').hidden;
  const when=value=>Number.isFinite(value)
    ? new Date(value*1000).toLocaleString('ru-RU'):'—';

  async function loadDetails() {
    if(!visible() || state.callId===null)return;
    const generation=++state.generation;
    const callId=state.callId;
    $('tool-call-refresh').disabled=true;
    $('tool-call-copy').disabled=true;
    $('tool-call-status').textContent='Загрузка…';
    try {
      const response=await fetch(
        new URL('/api/v1/dashboard/tool-history/'+encodeURIComponent(callId),location.origin).href,
        {method:'GET',cache:'no-store',credentials:'same-origin',headers:{'Accept':'application/json'}}
      );
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(response.status===404
        ?'Запись уже удалена из истории (хранятся последние 100 вызовов).'
        :response.status===401?'Требуется авторизация администратора'
        :data.detail||'HTTP '+response.status);
      if(data.id!==callId || typeof data.tool_name!=='string' ||
         (data.arguments!==null && (typeof data.arguments!=='object' ||
         Array.isArray(data.arguments))))throw Error('Некорректный ответ сервера');
      if(generation!==state.generation || !visible() || callId!==state.callId)return;
      $('tool-call-title').textContent=data.tool_name;
      $('tool-call-meta').textContent=
        'Вызов #'+data.id+' · '+(data.agent_name||data.agent_id||'Неизвестный агент')+
        (data.agent_id?' · agent_id: '+data.agent_id:'')+
        ' · '+when(data.created_at);
      $('tool-call-status').textContent=
        (data.status==='ok'?'Успешно':'Ошибка')+
        ' · '+Number(data.duration_ms).toFixed(2)+' мс'+
        (data.arguments_truncated?' · Аргументы обрезаны':'');
      state.raw=data.arguments===null
        ?'Аргументы для этого вызова не сохранялись (запись создана до обновления).'
        :JSON.stringify(data.arguments,null,2);
      $('tool-call-arguments').textContent=state.raw;
      $('tool-call-copy').disabled=data.arguments===null;
    } catch(error) {
      if(generation!==state.generation || !visible())return;
      state.raw='';
      $('tool-call-status').textContent='Ошибка';
      $('tool-call-arguments').textContent=String(error.message||error);
    } finally {
      if(generation===state.generation && visible())$('tool-call-refresh').disabled=false;
    }
  }

  function open(callId) {
    if(!Number.isSafeInteger(callId)||callId<1)return;
    if(!visible())state.previousFocus=document.activeElement;
    state.callId=callId;
    state.raw='';
    ++state.generation;
    $('tool-call-title').textContent='Вызов инструмента';
    $('tool-call-meta').textContent='Вызов #'+callId;
    $('tool-call-status').textContent='Загрузка…';
    $('tool-call-arguments').textContent='Загрузка…';
    $('tool-call-overlay').hidden=false;
    document.body.classList.add('tool-call-open');
    $('tool-call-scroll').scrollTop=0;
    $('tool-call-close').focus();
    void loadDetails();
  }

  function close() {
    if(!visible())return;
    ++state.generation;
    $('tool-call-overlay').hidden=true;
    document.body.classList.remove('tool-call-open');
    state.callId=null;
    state.raw='';
    $('tool-call-arguments').textContent='';
    const focus=state.previousFocus;
    state.previousFocus=null;
    if(focus?.isConnected)focus.focus();
  }

  document.addEventListener('agent-network:tool-call-detail',event=>
    open(event.detail?.callId));
  $('tool-call-close').addEventListener('click',close);
  $('tool-call-backdrop').addEventListener('click',close);
  $('tool-call-refresh').addEventListener('click',()=>void loadDetails());
  $('tool-call-copy').addEventListener('click',async()=>{
    const raw=state.raw;
    if(!raw)return;
    try {
      await navigator.clipboard.writeText(raw);
      if(visible() && state.raw===raw)
        $('tool-call-status').textContent='JSON скопирован';
    }catch {
      if(visible())$('tool-call-status').textContent='Не удалось скопировать JSON';
    }
  });
  document.addEventListener('keydown',event=>{
    if(!visible())return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const buttons=[...$('tool-call-dialog').querySelectorAll(
      'button:not([disabled])'
    )];
    if(!buttons.length)return;
    if(event.shiftKey && document.activeElement===buttons[0]){
      event.preventDefault();buttons[buttons.length-1].focus();
    }else if(!event.shiftKey && document.activeElement===buttons[buttons.length-1]){
      event.preventDefault();buttons[0].focus();
    }
  });
})();
