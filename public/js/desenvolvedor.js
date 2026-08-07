(() => {
  'use strict';
  const TOKEN_KEY='papi_developer_token';
  const $=(s)=>document.querySelector(s), esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={token:sessionStorage.getItem(TOKEN_KEY)||'',user:null,view:'dashboard',tenants:[],plans:[]};
  const views=[['dashboard','Dashboard'],['tenants','Empresas'],['plans','Planos e Assinaturas'],['financial','Financeiro'],['contracts','Contratos'],['domains','Domínios'],['users','Usuários'],['leads','Leads comerciais'],['site','Site'],['evolution','Evolution API'],['api','API'],['logs','Logs'],['backups','Backups e Recuperação'],['settings','Configurações']];
  const LEAD_STATUSES=[['new','Novo'],['contacted','Contatado'],['demo_scheduled','Demonstração marcada'],['proposal_sent','Proposta enviada'],['customer','Cliente'],['lost','Perdido']];
  const SITE_IMAGE_SLOTS=[['logo','Logo (cabeçalho e rodapé)'],['favicon','Favicon / ícone do app (PWA)'],['hero','Mockup do hero'],['demo_agenda','Demonstração — Agenda'],['demo_servicos','Demonstração — Serviços'],['demo_unidades','Demonstração — Unidades'],['demo_financeiro','Demonstração — Financeiro'],['demo_painel','Demonstração — Painel administrativo']];
  async function api(url,opt={}){const headers={'Content-Type':'application/json',...(opt.headers||{})};if(state.token)headers.Authorization='Bearer '+state.token;const r=await fetch(url,{...opt,headers});if(r.status===401&&url!=='/api/developer/login')logout();const data=(r.headers.get('content-type')||'').includes('json')?await r.json():null;if(!r.ok)throw new Error(data?.error||'Não foi possível concluir a operação.');return data}
  function toast(msg){const e=$('#toast');e.textContent=msg;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2600)}
  function loading(){ $('#content').innerHTML='<div class="panel empty">Carregando…</div>' }
  function logout(){state.token='';state.user=null;sessionStorage.removeItem(TOKEN_KEY);localStorage.removeItem(TOKEN_KEY);$('#appView').classList.add('hidden');$('#loginView').classList.remove('hidden')}
  function table(headers,rows){return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${headers.length}" class="empty">Nenhum registro encontrado.</td></tr>`}</tbody></table></div>`}
  function date(v){return v?new Intl.DateTimeFormat('pt-BR').format(new Date(v+'T00:00:00')):'—'}
  function openModal(){if(!$('#modal').open)$('#modal').showModal()}
  function roleLabel(r){return {developer:'Desenvolvedor',owner:'Proprietário',admin:'Administrador',employee:'Funcionário'}[r]||r}
  /* Botões de ação compactos (somente ícones), mesmo padrão usado no admin do tenant. */
  const ICONS={accept:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',cancel:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',delete:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',detail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',backup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M20 21H4"/></svg>',restore:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',login:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>',star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>'};
  function iconBtn(icon,cls,action,id,label){return `<button type="button" class="action-btn action-btn-${cls}" data-action="${action}" data-id="${id}" title="${label}" aria-label="${label}">${ICONS[icon]}</button>`}
  async function boot(){if(!state.token)return logout();try{state.user=await api('/api/developer/me');$('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#developerName').textContent=state.user.name;buildNav();await render()}catch{logout()}}
  function buildNav(){ $('#nav').innerHTML=views.map(([id,name])=>`<button class="nav-button ${id===state.view?'active':''}" data-view="${id}">${name}</button>`).join('');$('#nav').onclick=e=>{const b=e.target.closest('[data-view]');if(!b)return;state.view=b.dataset.view;$('#sidebar').classList.remove('open');buildNav();render()}}
  async function render(){const label=views.find(v=>v[0]===state.view)?.[1]||'';$('#pageTitle').textContent=label;loading();try{await ({dashboard,tenants,plans,financial,contracts,domains,users,leads,site,evolution,apiView,logs,backups,settings}[state.view]||dashboard)()}catch(e){$('#content').innerHTML=`<div class="panel error">${esc(e.message)}</div>`}}
  function money(v){return 'R$ '+Number(v||0).toFixed(2)}
  function financialTypeLabel(t){return {MONTHLY:'Mensalidade',PACKAGE:'Pacote parcelado',PERCENTAGE:'Porcentagem'}[t]||t}
  function financialStatusBadge(e){if(e.status==='PAID')return '<span class="status status-paid">Pago</span>';if(e.status==='CANCELED')return '<span class="status status-canceled">Cancelado</span>';if(e.is_overdue)return '<span class="status status-overdue">Atrasado</span>';return '<span class="status status-pending">Pendente</span>'}
  async function dashboard(){const d=await api('/api/developer/dashboard');const cards=[['Empresas',d.tenants],['Ativas',d.active],['Suspensas',d.suspended],['Expiradas',d.expired],['Usuários',d.company_users],['Domínios',d.domains],['Planos',d.plans],['Bancos de tenant',d.tenant_databases],['Aceites jurídicos registrados',d.legal_acceptances],['Agendamentos sem aceite jurídico',d.appointments_without_legal_acceptance]];$('#content').innerHTML=`<section class="cards">${cards.map(c=>`<article class="card"><span class="muted">${c[0]}</span><strong>${c[1]??0}</strong></article>`).join('')}</section><h2>Atividade recente</h2>${table(['Data','Ação','Responsável'],(d.recent_logs||[]).map(l=>`<tr><td>${esc(l.created_at)}</td><td>${esc(l.action)}</td><td>${esc(l.user_name||'Sistema')}</td></tr>`))}`}
  async function loadBase(){[state.tenants,state.plans]=await Promise.all([api('/api/developer/tenants'),api('/api/developer/plans')])}
  async function tenants(){await loadBase();$('#content').innerHTML=`<div class="toolbar"><input id="search" placeholder="Pesquisar empresa"><select id="status"><option value="">Todos os status</option><option>ACTIVE</option><option>SUSPENDED</option><option>TRIAL</option><option>ARCHIVED</option></select><select id="plan"><option value="">Todos os planos</option>${state.plans.map(p=>`<option>${esc(p.slug)}</option>`)}</select><button id="newTenant" class="primary">Nova empresa</button></div><div id="tenantTable"></div>`;const draw=()=>{const q=$('#search').value.toLowerCase(),s=$('#status').value,p=$('#plan').value;const rows=state.tenants.filter(t=>(t.name+' '+t.slug).toLowerCase().includes(q)&&(!s||t.status===s)&&(!p||t.plan===p)).map(t=>`<tr class="row-click" data-id="${t.id}"><td>${t.id}</td><td><b>${esc(t.name)}</b><br><small>${esc(t.slug)}</small></td><td>${esc(t.plan)}</td><td>${esc(t.domains?.find(d=>d.is_primary)?.domain||'—')}</td><td><span class="status">${esc(t.status)}</span></td><td>${date(t.expires_at)}</td><td>${t.user_count}</td><td><div class="row-actions">${iconBtn(t.status==='SUSPENDED'?'accept':'cancel',t.status==='SUSPENDED'?'success':'warn','toggle',t.id,t.status==='SUSPENDED'?'Reativar empresa':'Suspender empresa')}${iconBtn('backup','neutral','backup',t.id,'Gerar backup')}${iconBtn('login','edit','impersonate',t.id,'Entrar como proprietário')}${iconBtn('delete','danger','delete',t.id,'Excluir empresa')}</div></td></tr>`);$('#tenantTable').innerHTML=table(['ID / Empresa','Nome','Plano','Domínio','Status','Vencimento','Usuários','Ações'],rows)};draw();$('#search').oninput=draw;$('#status').onchange=draw;$('#plan').onchange=draw;$('#newTenant').onclick=()=>openTenantForm();$('#tenantTable').onclick=tenantAction}
  async function apiForm(url,fd){const headers={};if(state.token)headers.Authorization='Bearer '+state.token;const r=await fetch(url,{method:'POST',headers,body:fd});if(r.status===401&&url!=='/api/developer/login')logout();const data=(r.headers.get('content-type')||'').includes('json')?await r.json():null;if(!r.ok)throw new Error(data?.error||'Não foi possível concluir a operação.');return data}
  function normalizeDomainInput(v){let d=String(v||'').trim().toLowerCase();if(d.includes('://'))d=d.split('://')[1];d=d.split('/')[0];d=d.replace(/:\d+$/,'');if(d.startsWith('www.'))d=d.slice(4);return d}
  function slugifyName(str){return String(str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)}
  function generateSecurePassword(){const up='ABCDEFGHJKLMNPQRSTUVWXYZ',lo='abcdefghijkmnpqrstuvwxyz',nm='23456789',sy='!@#$%&*+-=?_',all=up+lo+nm+sy;let p='';p+=up[Math.floor(Math.random()*up.length)];p+=lo[Math.floor(Math.random()*lo.length)];p+=nm[Math.floor(Math.random()*nm.length)];p+=sy[Math.floor(Math.random()*sy.length)];for(let i=0;i<8;i++)p+=all[Math.floor(Math.random()*all.length)];return p.split('').sort(()=>Math.random()-0.5).join('')}
  function copyText(text){const done=()=>toast('Copiado para a área de transferência.');if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text))}else fallbackCopy(text)}
  function fallbackCopy(text){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast('Copiado para a área de transferência.')}catch(e){toast('Não foi possível copiar.')}document.body.removeChild(ta)}
  function validateTenantForm(fd,editing){const errors=[];if(!fd.name||String(fd.name).trim().length<2)errors.push({field:'name',msg:'Informe o nome da empresa.'});if(fd.slug&&!/^[a-z0-9-]+$/.test(fd.slug))errors.push({field:'slug',msg:'Slug inválido (use minúsculas, números e hífens).'});if(fd.domain){const nd=normalizeDomainInput(fd.domain);if(nd&&(!nd.includes('.')||/\s/.test(nd)))errors.push({field:'domain',msg:'Informe um domínio válido (ex: suasite.com.br).'})}if(!editing){if(!fd.adminName||String(fd.adminName).trim().length<2)errors.push({field:'adminName',msg:'Informe o nome do administrador.'});if(!fd.adminEmail)errors.push({field:'adminEmail',msg:'Informe o e-mail de acesso ao painel.'});else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fd.adminEmail))errors.push({field:'adminEmail',msg:'Informe um e-mail válido.'});if(!fd.adminPassword)errors.push({field:'adminPassword',msg:'Informe a senha inicial.'});else if(String(fd.adminPassword).length<8)errors.push({field:'adminPassword',msg:'A senha deve ter pelo menos 8 caracteres.'});if(!fd.confirmPassword)errors.push({field:'confirmPassword',msg:'Confirme a senha.'});else if(fd.adminPassword!==fd.confirmPassword)errors.push({field:'confirmPassword',msg:'As senhas não coincidem.'});}return errors}
  function showFormErrors(errors){document.querySelectorAll('#tenantForm .field-error').forEach(el=>el.classList.remove('field-error'));const box=$('#formErrors');if(!box)return;if(!errors.length){box.classList.add('hidden');box.innerHTML='';return}box.classList.remove('hidden');box.innerHTML=`<strong>Corrija os campos abaixo:</strong><ul>${errors.map(er=>`<li>${esc(er.msg)}</li>`).join('')}</ul>`;errors.forEach(er=>{const el=document.querySelector(`#tenantForm [name="${er.field}"]`);if(el)el.classList.add('field-error')})}
  function updateAccessPreview(){const input=$('#domainInput');const box=$('#accessPreview');if(!input||!box)return;const d=normalizeDomainInput(input.value);if(!d){box.classList.add('hidden');box.innerHTML='';return}box.classList.remove('hidden');box.innerHTML=`<div class="access-preview"><span>Acesso administrativo</span><code>https://${esc(d)}/admin</code></div>`}
  function showCreatedSuccess(created,fd){const domain=normalizeDomainInput(fd.domain||'');const accessUrl=domain?`https://${domain}/admin`:null;$('#modalBody').innerHTML=`<div class="success-card"><h2>Empresa criada com sucesso.</h2><p class="muted">As credenciais abaixo são do painel administrativo da empresa.</p><div class="success-rows"><div><span>Empresa</span><b>${esc(created.name)}</b></div><div><span>Administrador</span><b>${esc(fd.adminName)}</b></div><div><span>Login</span><b>${esc(fd.adminEmail)}</b></div>${accessUrl?`<div><span>Acesso</span><b>${esc(accessUrl)}</b></div>`:''}${fd.adminPassword?`<div class="once"><span>Senha inicial</span><b class="one-time">${esc(fd.adminPassword)}</b><small class="warn">Guarde esta senha. Ela não poderá ser consultada novamente.</small></div>`:''}<div><span>Configuração da agenda</span><b class="status">Pendente</b></div></div><p class="muted wide">Acesse o painel administrativo da empresa para cadastrar a primeira unidade, serviços, formas de atendimento e horários. Enquanto isso, o site público exibe a tela "Agenda em configuração".</p>${accessUrl?`<button type="button" class="primary" id="copyAccess">Copiar dados de acesso</button>`:''}<button type="button" id="successClose" class="ghost">Fechar</button></div>`;openModal();if(accessUrl&&$('#copyAccess'))$('#copyAccess').onclick=()=>copyText(`Empresa: ${created.name}\nAcesso: ${accessUrl}\nLogin: ${fd.adminEmail}`);$('#successClose').onclick=()=>{$('#modal').close();render()}}
  function renderOwnerSection(tenant,owner){const box=$('#ownerSection');if(!box)return;if(!owner){box.innerHTML=`<p class="muted">Nenhum administrador vinculado a esta empresa.</p>`;return}box.innerHTML=`<div class="owner-card"><div class="owner-grid"><div><span>Nome</span><b>${esc(owner.name)}</b></div><div><span>E-mail de acesso</span><b>${esc(owner.email)}</b></div><div><span>Perfil</span><b>${esc(roleLabel(owner.role))}</b></div><div><span>Status</span><b class="${owner.active?'ok':'bad'}">${owner.active?'Ativo':'Inativo'}</b></div></div><div class="actions owner-actions"><button type="button" data-owner-action="edit-name">Editar nome</button><button type="button" data-owner-action="edit-email">Editar e-mail</button><button type="button" data-owner-action="reset-pass">Redefinir senha</button><button type="button" data-owner-action="toggle-active" class="${owner.active?'danger':''}">${owner.active?'Desativar':'Ativar'}</button></div></div>`;box.onclick=async e=>{const b=e.target.closest('[data-owner-action]');if(!b)return;if(b.dataset.ownerAction==='toggle-active'){if(!confirm(`${owner.active?'Desativar':'Ativar'} o administrador "${owner.email}"?`))return;try{await api(`/api/developer/tenants/${tenant.id}/owner`,{method:'PATCH',body:JSON.stringify({active:owner.active?0:1})});toast('Status do administrador atualizado.');loadTenantUsers(tenant)}catch(err){toast(err.message)}return}showOwnerMiniForm(tenant,owner,b.dataset.ownerAction)}}
  function showOwnerMiniForm(tenant,owner,action){const box=$('#ownerSection');if(!box)return;let body='';if(action==='name'){body=`<div class="owner-card"><h4>Editar nome do administrador</h4><form id="ownerMiniForm" class="grid-form"><label>Nome do administrador<input name="ownerName" value="${esc(owner.name)}" required></label><div class="actions wide"><button type="button" data-cancel-owner>Cancelar</button><button class="primary" type="submit">Salvar</button></div></form></div>`}else if(action==='email'){body=`<div class="owner-card"><h4>Editar e-mail de acesso</h4><p class="muted wide">Novo login para acessar /admin no domínio da empresa.</p><form id="ownerMiniForm" class="grid-form"><label>E-mail de acesso ao painel<input name="ownerEmail" type="email" value="${esc(owner.email)}" required></label><div class="actions wide"><button type="button" data-cancel-owner>Cancelar</button><button class="primary" type="submit">Salvar</button></div></form></div>`}else{body=`<div class="owner-card"><h4>Redefinir senha</h4><form id="ownerMiniForm" class="grid-form"><label>Nova senha<input name="new_password" type="password" minlength="8" required placeholder="Mínimo de 8 caracteres" autocomplete="new-password"></label><label>Confirmar nova senha<input name="confirm_password" type="password" minlength="8" required placeholder="Repita a senha" autocomplete="new-password"></label><div class="actions wide"><button type="button" data-cancel-owner>Cancelar</button><button class="primary" type="submit">Salvar</button></div></form></div>`}box.innerHTML=body;box.querySelector('[data-cancel-owner]').onclick=()=>loadTenantUsers(tenant);$('#ownerMiniForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{if(action==='name'){const name=$('#ownerMiniForm [name="ownerName"]').value;if(!name||name.trim().length<2)throw new Error('Informe o nome do administrador.');await api(`/api/developer/tenants/${tenant.id}/owner`,{method:'PATCH',body:JSON.stringify({name:name.trim()})});toast('Nome do administrador atualizado.')}else if(action==='email'){const em=$('#ownerMiniForm [name="ownerEmail"]').value;if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))throw new Error('Informe um e-mail válido.');await api(`/api/developer/tenants/${tenant.id}/owner`,{method:'PATCH',body:JSON.stringify({email:em})});toast('E-mail de acesso atualizado.')}else{const p=$('#ownerMiniForm [name="new_password"]').value,c=$('#ownerMiniForm [name="confirm_password"]').value;if(!p||p.length<8)throw new Error('A nova senha deve ter pelo menos 8 caracteres.');if(p!==c)throw new Error('As senhas não coincidem.');await api(`/api/developer/tenants/${tenant.id}/reset-password`,{method:'POST',body:JSON.stringify({new_password:p,confirm_password:c})});toast('Senha redefinida.')}loadTenantUsers(tenant)}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  function openTenantForm(tenant){const editing=Boolean(tenant);const opts=state.plans.map(p=>`<option value="${esc(p.slug)}" ${editing&&tenant.plan===p.slug?'selected':''}>${esc(p.name)}</option>`).join('');const statusList=editing?['ACTIVE','TRIAL','SUSPENDED','ARCHIVED']:['ACTIVE','TRIAL','SUSPENDED'];const statusOpts=statusList.map(s=>`<option ${editing&&tenant.status===s?'selected':''}>${s}</option>`).join('');const primaryDomainObj=editing?tenant.domains?.find(d=>d.is_primary):null;const extraDomains=editing?(tenant.domains?.length||0)-(primaryDomainObj?1:0):0;const companySection=`
      <div class="form-section wide">
        <h3>Dados da empresa</h3>
        <div class="grid-form">
          <label>Nome da empresa *<input name="name" id="tenantName" value="${editing?esc(tenant.name):''}" required></label>
          <label>Slug<input name="slug" id="tenantSlug" pattern="[a-z0-9\\-]+" ${editing?'':'readonly title="Gerado automaticamente do nome da empresa"'} value="${editing?esc(tenant.slug):''}" placeholder="Gerado do nome">${editing?'':'<small class="help">Gerado automaticamente a partir do nome da empresa.</small>'}</label>
          <label>Plano *<select name="plan">${opts}</select></label>
          <label>Status *<select name="status">${statusOpts}</select></label>
          <label>Documento (CNPJ/CPF)<input name="document" value="${editing?esc(tenant.document||''):''}"></label>
          <label>E-mail comercial da empresa<input name="email" type="email" value="${editing?esc(tenant.email||''):''}" placeholder="Não usado como login"></label>
          <label>Telefone<input name="phone" value="${editing?esc(tenant.phone||''):''}"></label>
          <label>Domínio principal<input name="domain" id="domainInput" value="${editing?esc(primaryDomainObj?.domain||''):''}" placeholder="suasite.com.br"></label>
          <label>Vencimento<input name="expires_at" type="date" value="${editing&&tenant.expires_at?tenant.expires_at:''}"></label>
        </div>
        <div id="accessPreview" class="access-preview-wrap hidden"></div>
        ${editing&&extraDomains>0?`<p class="muted wide">Esta empresa também tem ${extraDomains} domínio(s) secundário(s) — gerencie na aba "Domínios".</p>`:''}
      </div>`;const adminSection=editing?'':`
      <div class="form-section wide">
        <h3>Administrador da empresa</h3>
        <p class="muted wide">Estas credenciais serão usadas pelo cliente para acessar <code>/admin</code> no domínio da empresa. O usuário administra somente esta empresa.</p>
        <div class="grid-form">
          <label>Nome do administrador *<input name="adminName" required></label>
          <label>E-mail de acesso ao painel *<input name="adminEmail" type="email" required><small class="help">Este será o login usado para acessar /admin no domínio da empresa.</small></label>
          <label>Senha inicial *<span class="password"><input name="adminPassword" id="adminPassword" type="password" minlength="8" required autocomplete="new-password"><button type="button" id="togglePassword1">Mostrar</button></span><small class="help">O administrador usará esta senha no primeiro acesso. Mínimo de 8 caracteres.</small></label>
          <label>Confirmar senha *<span class="password"><input name="confirmPassword" id="confirmPassword" type="password" minlength="8" required autocomplete="new-password"><button type="button" id="togglePassword2">Mostrar</button></span></label>
        </div>
        <div class="password-tools wide">
          <button type="button" id="genPassword" class="ghost">Gerar senha segura</button>
          <button type="button" id="copyPassword" class="ghost">Copiar senha</button>
        </div>
      </div>`;const ownerSection=editing?`
      <div class="form-section wide">
        <h3>Administrador principal</h3>
        <p class="muted">Dados de acesso do responsável principal por esta empresa.</p>
        <div id="ownerSection" class="muted">Carregando…</div>
      </div>
      <div class="section-head"><h3>Usuários da empresa</h3><button type="button" id="addTenantUser" class="primary">+ Novo usuário</button></div>
      <div id="tenantUsersList" class="muted">Carregando…</div>
      <div class="section-head"><h3>Identidade Visual</h3><p class="muted">Logo e favicon exibidos no site público e no painel da empresa.</p></div>
      <div id="brandingBox" class="wide muted">Carregando…</div>`:'';const bottomActions=`<div class="actions wide form-footer-actions"><button type="button" data-close>Cancelar</button><button class="primary" type="submit" form="tenantForm">${editing?'Salvar alterações':'Criar empresa'}</button></div>`;$('#modalBody').innerHTML=`<h2>${editing?'Editar empresa':'Nova empresa'}</h2><form id="tenantForm" class="grid-form" novalidate>${companySection}${adminSection}<div id="formErrors" class="form-errors wide hidden"></div></form>${ownerSection}${bottomActions}`;openModal();$('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#domainInput').oninput=updateAccessPreview;updateAccessPreview();if(!editing){const nameInput=$('#tenantName'),slugInput=$('#tenantSlug');slugInput.value=slugifyName(nameInput.value);nameInput.oninput=()=>{slugInput.value=slugifyName(nameInput.value)}}if(!editing){$('#genPassword').onclick=()=>{const p=generateSecurePassword();$('#adminPassword').value=p;$('#confirmPassword').value=p;toast('Senha segura gerada.')};$('#copyPassword').onclick=()=>{const p=$('#adminPassword').value;if(!p)return toast('Gere uma senha primeiro.');copyText(p)};$('#togglePassword1').onclick=()=>{const p=$('#adminPassword');p.type=p.type==='password'?'text':'password';$('#togglePassword1').textContent=p.type==='password'?'Mostrar':'Ocultar'};$('#togglePassword2').onclick=()=>{const p=$('#confirmPassword');p.type=p.type==='password'?'text':'password';$('#togglePassword2').textContent=p.type==='password'?'Mostrar':'Ocultar'}}let submitting=false;$('#tenantForm').onsubmit=async e=>{e.preventDefault();if(submitting)return;submitting=true;const btn=e.submitter;btn.disabled=true;const fd=Object.fromEntries(new FormData(e.target));const errors=validateTenantForm(fd,editing);showFormErrors(errors);if(errors.length){submitting=false;btn.disabled=false;return}fd.domain=normalizeDomainInput(fd.domain||'');try{if(editing){await api(`/api/developer/tenants/${tenant.id}`,{method:'PUT',body:JSON.stringify(fd)});if(fd.domain&&fd.domain!==(primaryDomainObj?.domain||'')){try{if(primaryDomainObj)await api(`/api/developer/domains/${primaryDomainObj.id}`,{method:'PATCH',body:JSON.stringify({domain:fd.domain})});else await api(`/api/developer/tenants/${tenant.id}/domains`,{method:'POST',body:JSON.stringify({domain:fd.domain,is_primary:true})})}catch(domErr){toast(`Empresa atualizada, mas o domínio não foi salvo: ${domErr.message}`);$('#modal').close();render();return}}$('#modal').close();toast('Empresa atualizada.');render()}else{const created=await api('/api/developer/tenants',{method:'POST',body:JSON.stringify(fd)});showCreatedSuccess(created,fd)}}catch(err){toast(err.message)}finally{submitting=false;if(btn)btn.disabled=false}};if(editing){loadTenantUsers(tenant);$('#addTenantUser').onclick=()=>openTenantUserForm(tenant);loadBranding(tenant.id)}}

  async function loadTenantUsers(tenant){const list=$('#tenantUsersList');if(!list)return;try{const users=await api(`/api/developer/users?tenant_id=${tenant.id}`);renderOwnerSection(tenant,users.find(u=>u.role==='owner')||users[0]||null);list.innerHTML=users.length?users.map(u=>`<div class="user-row"><span><b>${esc(u.name)}</b><br><small class="muted">${esc(u.email)}</small></span><span class="status">${esc(roleLabel(u.role))}</span><span>${u.active?'Ativo':'Inativo'}</span><span><button type="button" data-action="edit-user" data-id="${u.id}">Editar</button><button type="button" data-action="delete-user" data-id="${u.id}">Excluir</button></span></div>`).join(''):'<p class="muted">Nenhum usuário cadastrado.</p>';list.onclick=async e=>{const b=e.target.closest('[data-action]');if(!b)return;const u=users.find(x=>String(x.id)===b.dataset.id);if(!u)return;if(b.dataset.action==='edit-user')return openTenantUserForm(tenant,u);if(b.dataset.action==='delete-user'){if(!confirm(`Excluir o usuário "${u.name}" (${u.email})?${u.role==='owner'?' Este é o proprietário da empresa.':''}`))return;try{await api(`/api/developer/users/${u.id}`,{method:'DELETE'});toast('Usuário excluído.');loadTenantUsers(tenant)}catch(err){toast(err.message)}}}}catch(err){list.innerHTML=`<p class="error">${esc(err.message)}</p>`}}
  function openTenantUserForm(tenant,user){const editing=Boolean(user);$('#modalBody').innerHTML=`<h2>${editing?'Editar usuário':'Novo usuário'} — ${esc(tenant.name)}</h2><form id="userForm" class="grid-form"><label>Nome<input name="name" value="${editing?esc(user.name):''}" required></label><label>E-mail<input name="email" type="email" value="${editing?esc(user.email):''}" ${editing?'disabled':''} required></label><label>${editing?'Nova senha (opcional)':'Senha'}<input name="password" type="password" minlength="6" placeholder="${editing?'Deixe em branco para manter':''}" ${editing?'':'required'}></label><label>Papel<select name="role"><option value="admin" ${!editing||user.role==='admin'?'selected':''}>Administrador</option><option value="employee" ${editing&&user.role==='employee'?'selected':''}>Funcionário</option><option value="owner" ${editing&&user.role==='owner'?'selected':''}>Proprietário</option></select></label>${editing?`<label>Status<select name="active"><option value="1" ${user.active?'selected':''}>Ativo</option><option value="0" ${!user.active?'selected':''}>Inativo</option></select></label>`:''}<div class="actions wide"><button type="button" id="backToTenant">Voltar</button><button class="primary" type="submit">${editing?'Salvar':'Criar usuário'}</button></div></form>`;openModal();$('#backToTenant').onclick=()=>openTenantForm(tenant);$('#userForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));if(editing){const body={name:raw.name,role:raw.role,active:raw.active==='1'};if(raw.password)body.password=raw.password;await api(`/api/developer/users/${user.id}`,{method:'PUT',body:JSON.stringify(body)});toast('Usuário atualizado.')}else{const body={...raw,tenant_id:tenant.id};await api('/api/developer/users',{method:'POST',body:JSON.stringify(body)});toast('Usuário criado.')}openTenantForm(tenant)}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  async function tenantAction(e){const b=e.target.closest('[data-action]');if(b){const t=state.tenants.find(x=>String(x.id)===b.dataset.id);try{if(b.dataset.action==='toggle'){const status=t.status==='SUSPENDED'?'ACTIVE':'SUSPENDED';if(!confirm(`${status==='SUSPENDED'?'Suspender':'Reativar'} ${t.name}?`))return;await api(`/api/developer/tenants/${t.id}/status`,{method:'PATCH',body:JSON.stringify({status})});toast('Status atualizado.');render()}if(b.dataset.action==='backup'){const original=b.innerHTML;b.disabled=true;b.title='Gerando backup…';b.innerHTML='…';try{const run=await api(`/api/developer/tenants/${t.id}/backup`,{method:'POST'});toast('Backup criado com sucesso.');try{state.backups=await api('/api/developer/backups')}catch{}if(run.status==='SUCCESS'&&confirm('Backup concluído. Deseja baixar agora?'))fetchDownload(`/api/developer/backups/${run.id}/download`)}catch(err){toast('Falha ao criar backup: '+err.message)}finally{b.disabled=false;b.innerHTML=original;b.title='Gerar backup'}}if(b.dataset.action==='impersonate'){if(!confirm(`Entrar como proprietário de ${t.name} por até 30 minutos?`))return;const d=await api(`/api/developer/tenants/${t.id}/impersonate`,{method:'POST'});localStorage.setItem(`papicore_admin_token:${window.location.hostname}`,d.token);location.href=d.redirect}if(b.dataset.action==='delete'){openTenantDeleteConfirm(t)}}catch(err){toast(err.message)}return}const row=e.target.closest('tr[data-id]');if(row){const t=state.tenants.find(x=>String(x.id)===row.dataset.id);if(t)openTenantForm(t)}}
  function openTenantDeleteConfirm(tenant){$('#modalBody').innerHTML=`<h2>Excluir empresa</h2><p>Isso vai apagar <b>${esc(tenant.name)}</b> permanentemente: banco de dados, agendamentos, usuários, domínios e lançamentos financeiros. <b>Essa ação não pode ser desfeita.</b></p><form id="deleteTenantForm" class="grid-form"><label class="wide">Digite <b>${esc(tenant.name)}</b> ou <b>${esc(tenant.slug)}</b> para confirmar<input name="confirmation" required autocomplete="off"></label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary danger" type="submit">Excluir permanentemente</button></div></form>`;openModal();$('#deleteTenantForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#deleteTenantForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));await api(`/api/developer/tenants/${tenant.id}`,{method:'DELETE',body:JSON.stringify({confirmation:raw.confirmation})});$('#modal').close();toast('Empresa excluída permanentemente.');render()}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  function formatCents(c){if(c==null)return '—';return (Number(c)/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}
  function centsToInput(c){if(c==null)return '';return (Number(c)/100).toFixed(2).replace('.', ',')}
  function parseBRLToCents(v){let s=String(v||'').trim().replace(/R\$\s?/i,'').trim();if(!s)return null;if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');else if(s.includes('.')){const p=s.split('.');s=p.slice(0,-1).join('')+'.'+p[p.length-1]}const n=Number(s);if(!Number.isFinite(n)||n<0)return null;return Math.round(n*100)}
  function supportLevelLabel(s){return {standard:'Padrão',priority:'Prioritário',dedicated:'Dedicado',premium:'Premium'}[s]||s||'—'}
  function subscriptionStatusBadge(s){return {trial:'<span class="status status-pending">Teste</span>',active:'<span class="status status-paid">Ativa</span>',overdue:'<span class="status status-overdue">Em atraso</span>',suspended:'<span class="status status-overdue">Suspensa</span>',canceled:'<span class="status status-canceled">Cancelada</span>'}[s]||(`<span class="status">${esc(s||'—')}</span>`)}
  async function plans(){const [plansData,subsData]=await Promise.all([api('/api/developer/plans'),api('/api/developer/subscriptions')]);state.plans=plansData;state.subscriptions=subsData;$('#content').innerHTML=`<div class="tabs"><button type="button" data-tab="plans" class="active">Planos</button><button type="button" data-tab="subs">Assinaturas</button></div><div id="plansTab"></div><div id="subsTab" class="hidden"></div>`;$('#content').querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(!b)return;document.querySelectorAll('#content .tabs [data-tab]').forEach(x=>x.classList.toggle('active',x===b));$('#plansTab').classList.toggle('hidden',b.dataset.tab!=='plans');$('#subsTab').classList.toggle('hidden',b.dataset.tab!=='subs');if(b.dataset.tab==='subs')drawSubscriptions()};const drawPlans=()=>{$('#plansTab').innerHTML=`<div class="toolbar"><button id="newPlan" class="primary">Novo plano</button></div><div id="planTable"></div>`;const rows=state.plans.map(p=>`<tr><td><b>${esc(p.name)}</b><br><small class="muted">${esc(p.slug)}</small></td><td>${formatCents(p.monthly_price_cents)}</td><td>${p.max_units==null?'Ilimitado':p.max_units}</td><td>${esc(supportLevelLabel(p.support_level))}</td><td><span class="status">${p.is_active?'Ativo':'Inativo'}</span></td><td>${p.subscription_count||0}</td><td><div class="row-actions">${iconBtn('edit','edit','edit',p.id,'Editar plano')}${p.is_active?iconBtn('cancel','warn','deactivate',p.id,'Inativar plano'):iconBtn('accept','success','activate',p.id,'Ativar plano')}${iconBtn('delete','danger','delete',p.id,'Excluir plano')}</div></td></tr>`);$('#planTable').innerHTML=table(['Nome','Preço mensal','Limite de unidades','Suporte','Status','Empresas','Ações'],rows);$('#newPlan').onclick=()=>openPlanForm();$('#planTable').onclick=planAction};const drawSubscriptions=()=>{$('#subsTab').innerHTML=`<div id="subsTable"></div>`;const rows=state.subscriptions.map(s=>`<tr><td><b>${esc(s.tenant_name)}</b><br><small class="muted">${esc(s.tenant_slug)}</small></td><td>${esc(s.plan_name||'—')}</td><td>${subscriptionStatusBadge(s.status)}</td><td>${formatCents(s.effective_monthly_price_cents)}</td><td>${s.units?`${s.units.current} / ${s.units.max==null?'∞':s.units.max}`:'—'}</td><td>${date(s.next_due_date)}</td><td><div class="row-actions">${iconBtn('edit','edit','edit',s.id,'Gerenciar assinatura')}</div></td></tr>`);$('#subsTable').innerHTML=table(['Empresa','Plano','Status','Valor mensal','Unidades','Próximo vencimento','Ações'],rows);$('#subsTable').onclick=subsAction};drawPlans()}
  function openPlanForm(plan){const editing=Boolean(plan);const levels=[['standard','Padrão'],['priority','Prioritário'],['dedicated','Dedicado'],['premium','Premium']];$('#modalBody').innerHTML=`<h2>${editing?'Editar plano':'Novo plano'}</h2><form id="planForm" class="grid-form"><label>Nome *<input name="name" value="${editing?esc(plan.name):''}" required></label><label>Slug<input name="slug" value="${editing?esc(plan.slug):''}" placeholder="Gerado a partir do nome se vazio"></label><label>Preço mensal (R$) *<input name="monthly_price" inputmode="decimal" value="${editing?centsToInput(plan.monthly_price_cents):'0,00'}" placeholder="149,00" required></label><label>Limite de unidades<input name="max_units" type="number" min="1" placeholder="Vazio = ilimitado" value="${editing&&plan.max_units!=null?plan.max_units:''}"></label><label>Nível de suporte<select name="support_level">${levels.map(([v,l])=>`<option value="${v}" ${editing&&plan.support_level===v?'selected':''}>${l}</option>`).join('')}</select></label><label class="wide">Descrição<input name="description" value="${editing?esc(plan.description||''):''}" placeholder="O que está incluso neste plano?"></label>${editing?`<label>Status<select name="is_active"><option value="1" ${plan.is_active?'selected':''}>Ativo</option><option value="0" ${!plan.is_active?'selected':''}>Inativo</option></select></label>`:''}<div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">${editing?'Salvar alterações':'Criar plano'}</button></div></form>`;$('#modal').showModal();$('#planForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#planForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));const price=parseBRLToCents(raw.monthly_price);if(price===null||price===undefined)throw new Error('Informe um preço mensal válido.');if(!raw.name||String(raw.name).trim().length<2)throw new Error('Informe o nome do plano.');const body={name:String(raw.name).trim(),slug:raw.slug||undefined,monthly_price_cents:price,max_units:raw.max_units===''?null:Number(raw.max_units),support_level:raw.support_level,description:raw.description};if(editing)body.is_active=raw.is_active==='1';if(editing)await api(`/api/developer/plans/${plan.id}`,{method:'PUT',body:JSON.stringify(body)});else await api('/api/developer/plans',{method:'POST',body:JSON.stringify(body)});$('#modal').close();toast(editing?'Plano atualizado.':'Plano criado.');render()}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  async function planAction(e){const b=e.target.closest('[data-action]');if(!b)return;const plan=state.plans.find(p=>String(p.id)===b.dataset.id);if(!plan)return;if(b.dataset.action==='edit')return openPlanForm(plan);if(b.dataset.action==='activate'||b.dataset.action==='deactivate'){const is_active=b.dataset.action==='activate';if(!confirm(`${is_active?'Ativar':'Inativar'} o plano "${plan.name}"?`))return;try{await api(`/api/developer/plans/${plan.id}/status`,{method:'PUT',body:JSON.stringify({is_active})});toast('Status do plano atualizado.');render()}catch(err){toast(err.message)}return}if(b.dataset.action==='delete'){if(!confirm(`Excluir o plano "${plan.name}"?`))return;try{const r=await api(`/api/developer/plans/${plan.id}`,{method:'DELETE'});toast(r&&r.message?r.message:'Plano excluído.');render()}catch(err){toast(err.message)}}}
  function openSubscriptionForm(s){$('#modalBody').innerHTML=`<h2>Assinatura — ${esc(s.tenant_name)}</h2><form id="subsForm" class="grid-form"><label>Plano<select name="plan_id">${state.plans.map(p=>`<option value="${p.id}" ${String(s.plan_id)===String(p.id)?'selected':''}>${esc(p.name)} (${formatCents(p.monthly_price_cents)})</option>`).join('')}</select></label><label>Status<select name="status">${[['trial','Teste'],['active','Ativa'],['overdue','Em atraso'],['suspended','Suspensa'],['canceled','Cancelada']].map(([v,l])=>`<option value="${v}" ${s.status===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Valor customizado (R$)<input name="custom_monthly_price_cents" inputmode="decimal" value="${s.custom_monthly_price_cents!=null?centsToInput(s.custom_monthly_price_cents):''}" placeholder="Vazio = preço do plano"></label><label>Dia de cobrança<input name="billing_day" type="number" min="1" max="31" value="${s.billing_day||''}" placeholder="Ex.: 5"></label><label>Início do período<input name="current_period_start" type="date" value="${s.current_period_start||''}"></label><label>Fim do período<input name="current_period_end" type="date" value="${s.current_period_end||''}"></label><label>Próximo vencimento<input name="next_due_date" type="date" value="${s.next_due_date||''}"></label><label class="wide">Observações<textarea name="notes" rows="2" placeholder="Anotações internas">${esc(s.notes||'')}</textarea></label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">Salvar assinatura</button></div></form>`;openModal();$('#subsForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#subsForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));const body={plan_id:Number(raw.plan_id),status:raw.status,custom_monthly_price_cents:raw.custom_monthly_price_cents===''?null:parseBRLToCents(raw.custom_monthly_price_cents),billing_day:raw.billing_day===''?null:Number(raw.billing_day),current_period_start:raw.current_period_start||undefined,current_period_end:raw.current_period_end||undefined,next_due_date:raw.next_due_date||undefined,notes:raw.notes};await api(`/api/developer/tenants/${s.tenant_id}/subscription`,{method:'PUT',body:JSON.stringify(body)});$('#modal').close();toast('Assinatura atualizada.');render()}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  async function subsAction(e){const b=e.target.closest('[data-action]');if(!b)return;const s=state.subscriptions.find(x=>String(x.id)===b.dataset.id);if(!s)return;if(b.dataset.action==='edit')return openSubscriptionForm(s)}
  async function financial(){await loadBase();const entries=await api('/api/developer/financial');state.financial=entries;const totals=entries.reduce((acc,e)=>{if(e.status==='PAID')acc.paid+=Number(e.amount);else if(e.status==='CANCELED'){}else if(e.is_overdue)acc.overdue+=Number(e.amount);else acc.pending+=Number(e.amount);return acc},{paid:0,pending:0,overdue:0});$('#content').innerHTML=`<section class="cards"><article class="card"><span class="muted">Recebido</span><strong>${money(totals.paid)}</strong></article><article class="card"><span class="muted">Pendente</span><strong>${money(totals.pending)}</strong></article><article class="card"><span class="muted">Atrasado</span><strong>${money(totals.overdue)}</strong></article></section><div class="toolbar"><select id="fTenant"><option value="">Todas as empresas</option>${state.tenants.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><select id="fStatus"><option value="">Todos os status</option><option value="PENDING">Pendente</option><option value="PAID">Pago</option><option value="CANCELED">Cancelado</option></select><select id="fType"><option value="">Todos os tipos</option><option value="MONTHLY">Mensalidade</option><option value="PACKAGE">Pacote parcelado</option><option value="PERCENTAGE">Porcentagem</option></select><button id="newFinancial" class="primary">Nova cobrança</button></div><div id="financialTable"></div>`;const draw=()=>{const tf=$('#fTenant').value,sf=$('#fStatus').value,ty=$('#fType').value;const rows=state.financial.filter(e=>(!tf||String(e.tenant_id)===tf)&&(!sf||e.status===sf)&&(!ty||e.type===ty)).map(e=>`<tr><td>${esc(e.tenant?.name||'—')}</td><td>${esc(financialTypeLabel(e.type))}</td><td>${esc(e.description||'—')}${e.type==='PACKAGE'&&e.installment_number?` <small class="muted">(${e.installment_number}/${e.installment_total||'?'})</small>`:''}${e.type==='PERCENTAGE'&&e.percentage!=null?` <small class="muted">(${e.percentage}%)</small>`:''}</td><td>${money(e.amount)}</td><td>${date(e.due_date)}</td><td>${financialStatusBadge(e)}</td><td><div class="row-actions">${e.status==='PENDING'?iconBtn('accept','success','pay',e.id,'Marcar como pago'):''}${iconBtn('edit','edit','edit',e.id,'Editar cobrança')}${iconBtn('delete','danger','delete',e.id,'Excluir cobrança')}</div></td></tr>`);$('#financialTable').innerHTML=table(['Empresa','Tipo','Descrição','Valor','Vencimento','Status','Ações'],rows)};draw();$('#fTenant').onchange=draw;$('#fStatus').onchange=draw;$('#fType').onchange=draw;$('#newFinancial').onclick=()=>openFinancialForm();$('#financialTable').onclick=financialAction}
  function openFinancialForm(entry){const editing=Boolean(entry);const type=editing?entry.type:'MONTHLY';$('#modalBody').innerHTML=`<h2>${editing?'Editar cobrança':'Nova cobrança'}</h2><form id="financialForm" class="grid-form"><label>Empresa<select name="tenant_id" ${editing?'disabled':''} required>${state.tenants.map(t=>`<option value="${t.id}" ${editing&&entry.tenant_id===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label><label>Tipo de cobrança<select name="type" id="fType2"><option value="MONTHLY" ${type==='MONTHLY'?'selected':''}>Mensalidade</option><option value="PACKAGE" ${type==='PACKAGE'?'selected':''}>Pacote parcelado</option><option value="PERCENTAGE" ${type==='PERCENTAGE'?'selected':''}>Porcentagem</option></select></label><label class="wide">Descrição<input name="description" value="${editing?esc(entry.description||''):''}" placeholder="Ex: Mensalidade de agosto/2026"></label><label>Valor (R$)<input name="amount" type="number" step="0.01" min="0.01" value="${editing?entry.amount:''}" required></label><label>Vencimento<input name="due_date" type="date" value="${editing&&entry.due_date?entry.due_date:''}" required></label><div id="packageFields" class="grid-form wide" style="display:${type==='PACKAGE'?'grid':'none'}"><label>Parcela atual<input name="installment_number" type="number" min="1" value="${editing&&entry.installment_number!=null?entry.installment_number:''}"></label><label>Total de parcelas<input name="installment_total" type="number" min="1" value="${editing&&entry.installment_total!=null?entry.installment_total:''}"></label></div><div id="percentageFields" class="wide" style="display:${type==='PERCENTAGE'?'block':'none'}"><label>Percentual (%)<input name="percentage" type="number" step="0.01" min="0" max="100" value="${editing&&entry.percentage!=null?entry.percentage:''}"></label></div>${editing?`<label>Status<select name="status"><option value="PENDING" ${entry.status==='PENDING'?'selected':''}>Pendente</option><option value="PAID" ${entry.status==='PAID'?'selected':''}>Pago</option><option value="CANCELED" ${entry.status==='CANCELED'?'selected':''}>Cancelado</option></select></label>`:''}<label class="wide">Observações<input name="notes" value="${editing?esc(entry.notes||''):''}"></label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">${editing?'Salvar alterações':'Criar cobrança'}</button></div></form>`;openModal();$('#financialForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#fType2').onchange=ev=>{$('#packageFields').style.display=ev.target.value==='PACKAGE'?'grid':'none';$('#percentageFields').style.display=ev.target.value==='PERCENTAGE'?'block':'none'};$('#financialForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));const body={type:raw.type,description:raw.description,amount:raw.amount,due_date:raw.due_date,notes:raw.notes,installment_number:raw.installment_number||null,installment_total:raw.installment_total||null,percentage:raw.percentage||null};if(editing){body.status=raw.status;await api(`/api/developer/financial/${entry.id}`,{method:'PUT',body:JSON.stringify(body)})}else{body.tenant_id=raw.tenant_id;await api('/api/developer/financial',{method:'POST',body:JSON.stringify(body)})}$('#modal').close();toast(editing?'Cobrança atualizada.':'Cobrança criada.');render()}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  async function financialAction(e){const b=e.target.closest('[data-action]');if(!b)return;const entry=state.financial.find(x=>String(x.id)===b.dataset.id);if(!entry)return;if(b.dataset.action==='edit')return openFinancialForm(entry);if(b.dataset.action==='pay'){try{await api(`/api/developer/financial/${entry.id}`,{method:'PUT',body:JSON.stringify({status:'PAID'})});toast('Cobrança marcada como paga.');render()}catch(err){toast(err.message)}return}if(b.dataset.action==='delete'){if(!confirm(`Excluir esta cobrança de ${money(entry.amount)}?`))return;try{await api(`/api/developer/financial/${entry.id}`,{method:'DELETE'});toast('Cobrança excluída.');render()}catch(err){toast(err.message)}}}
  async function domains(){state.tenants=await api('/api/developer/tenants');const all=state.tenants.flatMap(t=>(t.domains||[]).map(d=>({...d,tenantName:t.name,tenantId:t.id})));state.domainsFlat=all;$('#content').innerHTML=`<div class="toolbar"><input id="dSearch" placeholder="Pesquisar domínio ou empresa"><select id="dTenant"><option value="">Todas as empresas</option>${state.tenants.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><select id="dStatus"><option value="">Todos os status</option><option value="1">Verificado</option><option value="0">Pendente</option></select><select id="dType"><option value="">Todos os tipos</option><option value="1">Principal</option><option value="0">Secundário</option></select><button id="newDomain" class="primary">Adicionar domínio</button></div><div id="domainsTable"></div>`;const draw=()=>{const q=$('#dSearch').value.toLowerCase(),tf=$('#dTenant').value,sf=$('#dStatus').value,tyf=$('#dType').value;const rows=all.filter(d=>(d.domain+' '+d.tenantName).toLowerCase().includes(q)&&(!tf||String(d.tenantId)===tf)&&(sf===''||String(d.verified?1:0)===sf)&&(tyf===''||String(d.is_primary?1:0)===tyf)).map(d=>`<tr><td>${esc(d.domain)}</td><td>${esc(d.tenantName)}</td><td>${d.verified?'Verificado':'Pendente'}</td><td>${d.is_primary?'Principal':'Secundário'}</td><td>${esc(d.created_at)}</td><td><div class="row-actions">${iconBtn('detail','neutral','dns',d.id,'Ver registros DNS')}${iconBtn(d.verified?'cancel':'accept',d.verified?'warn':'success','toggle-verified',d.id,d.verified?'Marcar como pendente':'Marcar como verificado')}${!d.is_primary?iconBtn('star','star','make-primary',d.id,'Tornar domínio principal'):''}${iconBtn('delete','danger','remove',d.id,'Remover domínio')}</div></td></tr>`);$('#domainsTable').innerHTML=table(['Domínio','Empresa','Status','Tipo','Criado em','Ações'],rows)};draw();$('#dSearch').oninput=draw;$('#dTenant').onchange=draw;$('#dStatus').onchange=draw;$('#dType').onchange=draw;$('#newDomain').onclick=()=>openDomainForm();$('#domainsTable').onclick=domainAction}
  function openDomainForm(){$('#modalBody').innerHTML=`<h2>Adicionar domínio</h2><form id="domainForm" class="grid-form"><label>Empresa<select name="tenant_id" required>${state.tenants.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>Domínio<input name="domain" placeholder="agenda.empresa.com.br" required></label><label class="wide"><input type="checkbox" name="is_primary" value="1"> Definir como domínio principal</label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">Adicionar</button></div></form>`;openModal();$('#domainForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#domainForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));await api(`/api/developer/tenants/${raw.tenant_id}/domains`,{method:'POST',body:JSON.stringify({domain:raw.domain,is_primary:raw.is_primary==='1'})});$('#modal').close();toast('Domínio adicionado.');render()}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  async function domainAction(e){const b=e.target.closest('[data-action]');if(!b)return;const d=state.domainsFlat.find(x=>String(x.id)===b.dataset.id);if(!d)return;try{if(b.dataset.action==='dns'){const info=await api(`/api/developer/domains/${d.id}/dns`);$('#modalBody').innerHTML=`<h2>DNS — ${esc(info.domain)}</h2>${table(['Tipo','Nome','Valor','TTL'],info.records.map(r=>`<tr><td>${esc(r.type)}</td><td>${esc(r.name)}</td><td>${esc(r.value)}</td><td>${esc(r.ttl)}</td></tr>`))}<ol>${info.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><div class="actions"><button type="button" data-close>Fechar</button></div>`;openModal();$('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();return}if(b.dataset.action==='toggle-verified'){await api(`/api/developer/domains/${d.id}`,{method:'PATCH',body:JSON.stringify({verified:!d.verified})});toast(d.verified?'Domínio marcado como pendente.':'Domínio marcado como verificado.');render();return}if(b.dataset.action==='make-primary'){await api(`/api/developer/domains/${d.id}`,{method:'PATCH',body:JSON.stringify({is_primary:true})});toast('Domínio definido como principal.');render();return}if(b.dataset.action==='remove'){if(!confirm(`Remover o domínio "${d.domain}"?`))return;await api(`/api/developer/domains/${d.id}`,{method:'DELETE'});toast('Domínio removido.');render()}}catch(err){toast(err.message)}}
  async function users(){state.tenants=await api('/api/developer/tenants');const all=await api('/api/developer/users');$('#content').innerHTML=`<div class="toolbar"><input id="uSearch" placeholder="Pesquisar nome ou e-mail"><select id="uTenant"><option value="">Todas as empresas</option><option value="null">Plataforma (desenvolvedor)</option>${state.tenants.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><select id="uRole"><option value="">Todos os perfis</option><option value="developer">Desenvolvedor</option><option value="owner">Proprietário</option><option value="admin">Administrador</option><option value="employee">Funcionário</option></select><select id="uStatus"><option value="">Todos os status</option><option value="1">Ativo</option><option value="0">Inativo</option></select></div><div id="usersTable"></div>`;const draw=()=>{const q=$('#uSearch').value.toLowerCase(),tf=$('#uTenant').value,rf=$('#uRole').value,sf=$('#uStatus').value;const rows=all.filter(u=>(u.name+' '+u.email).toLowerCase().includes(q)&&(!tf||(tf==='null'?!u.tenant_id:String(u.tenant_id)===tf))&&(!rf||u.role===rf)&&(sf===''||String(u.active?1:0)===sf)).map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.tenant?.name||'Plataforma')}</td><td>${esc(roleLabel(u.role))}</td><td>${u.active?'Ativo':'Inativo'}</td><td>${esc(u.created_at)}</td></tr>`);$('#usersTable').innerHTML=table(['Nome','E-mail','Empresa','Perfil','Status','Criado em'],rows)};draw();$('#uSearch').oninput=draw;$('#uTenant').onchange=draw;$('#uRole').onchange=draw;$('#uStatus').onchange=draw}
  async function logs(){const rows=await api('/api/developer/logs?limit=200');$('#content').innerHTML=table(['Data','Ação','Empresa','Responsável','Detalhes'],rows.map(l=>`<tr><td>${esc(l.created_at)}</td><td>${esc(l.action)}</td><td>${esc(l.tenant?.name||'—')}</td><td>${esc(l.user_name||'Sistema')}</td><td>${esc(l.details||'—')}</td></tr>`))}
  async function leads(){state.leads=await api('/api/developer/leads');$('#content').innerHTML=`<div class="toolbar"><select id="lStatus"><option value="">Todos os status</option>${LEAD_STATUSES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div><div id="leadsTable"></div>`;const draw=()=>{const sf=$('#lStatus').value;const rows=state.leads.filter(l=>!sf||l.status===sf).map(l=>`<tr><td><b>${esc(l.name)}</b>${l.message?`<br><small class="muted" title="${esc(l.message)}">${esc(l.message.length>60?l.message.slice(0,60)+'…':l.message)}</small>`:''}</td><td>${esc(l.company_name||'—')}</td><td>${esc(l.whatsapp||'—')}</td><td>${esc(l.city||'—')}</td><td>${l.units_count??'—'}</td><td>${esc(l.interested_plan||'—')}</td><td>${esc(l.created_at)}</td><td><select data-lead-status="${l.id}">${LEAD_STATUSES.map(([v,lb])=>`<option value="${v}" ${l.status===v?'selected':''}>${lb}</option>`).join('')}</select></td><td>${l.whatsapp?iconBtn('login','success','whatsapp',l.id,'Abrir contato'):'—'}</td></tr>`);$('#leadsTable').innerHTML=table(['Nome','Empresa','WhatsApp','Cidade','Unidades','Plano de interesse','Recebido em','Status','Contato'],rows)};draw();$('#lStatus').onchange=draw;$('#leadsTable').onclick=leadAction;$('#leadsTable').addEventListener('change',leadStatusChange)}
  async function leadStatusChange(e){const sel=e.target.closest('[data-lead-status]');if(!sel)return;const id=sel.dataset.leadStatus,status=sel.value;sel.disabled=true;try{await api(`/api/developer/leads/${id}/status`,{method:'PATCH',body:JSON.stringify({status})});const lead=state.leads.find(x=>String(x.id)===id);if(lead)lead.status=status;toast('Status do lead atualizado.')}catch(err){toast(err.message);render()}finally{sel.disabled=false}}
  function leadAction(e){const b=e.target.closest('[data-action="whatsapp"]');if(!b)return;const lead=state.leads.find(x=>String(x.id)===b.dataset.id);if(!lead||!lead.whatsapp)return;const digits=String(lead.whatsapp).replace(/\D/g,'');const text=encodeURIComponent(`Olá ${lead.name}! Vi seu contato pelo site do PapiCore.`);window.open(`https://wa.me/${digits}?text=${text}`,'_blank','noopener')}
  /* Aba "Site": vídeo, contato e imagens da landing page (papicore.com.br).
     Salvar aqui atualiza o site na hora — nada é editado em arquivo/código. */
  async function site(){state.site=await api('/api/developer/site-content');$('#content').innerHTML=`<div class="panel"><h2>Vídeo e contato</h2><p class="muted">Esses dados aparecem automaticamente no site institucional (papicore.com.br) assim que você salva.</p><form id="siteTextForm" class="grid-form"><label>URL do vídeo demonstrativo<input name="demo_video_url" value="${esc(state.site.demo_video_url)}" placeholder="https://www.youtube.com/watch?v=..."></label><label>WhatsApp comercial<input name="contact_whatsapp" value="${esc(state.site.contact_whatsapp)}" placeholder="(11) 91234-5678"></label><label>E-mail comercial<input name="contact_email" type="email" value="${esc(state.site.contact_email)}" placeholder="contato@papicore.com.br"></label><label>Instagram<input name="contact_instagram" value="${esc(state.site.contact_instagram)}" placeholder="@papicore"></label><div class="actions wide"><button class="primary" type="submit">Salvar</button></div></form></div><div class="section-head"><h3>Imagens da página</h3></div><div class="panel"><p class="muted">Envie aqui as imagens exibidas no site (mockup do hero e a galeria "Veja o PapiCore funcionando"). Ao enviar, a imagem substitui o placeholder automaticamente.</p><div class="branding-grid" id="siteImagesGrid"></div></div>`;renderSiteImages();$('#siteTextForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));state.site=await api('/api/developer/site-content',{method:'PUT',body:JSON.stringify(raw)});toast('Site atualizado.')}catch(err){toast(err.message)}finally{btn.disabled=false}}}
  function renderSiteImages(){const grid=$('#siteImagesGrid');if(!grid)return;grid.innerHTML=SITE_IMAGE_SLOTS.map(([slot,label])=>{const info=(state.site.images&&state.site.images[slot])||{has:false,url:null};return `<div class="branding-card"><div class="branding-preview">${info.has?`<img src="${esc(info.url)}" alt="${esc(label)}">`:`<span class="branding-placeholder">${esc(label)}<br>Nenhuma imagem enviada</span>`}</div><p class="muted">${esc(label)}</p><div class="branding-actions">${info.has?`<button type="button" data-site-remove="${slot}" class="danger">Remover</button>`:''}<label class="branding-upload">${info.has?'Substituir':'Enviar imagem'}<input type="file" data-site-file="${slot}" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden></label></div></div>`}).join('');grid.querySelectorAll('[data-site-remove]').forEach(btn=>{btn.onclick=async()=>{try{state.site=await api(`/api/developer/site-content/images/${btn.dataset.siteRemove}`,{method:'DELETE'}).then(d=>({...state.site,images:d.images}));toast('Imagem removida.')}catch(err){toast(err.message)}finally{renderSiteImages()}}});grid.querySelectorAll('[data-site-file]').forEach(input=>{input.onchange=async()=>{const file=input.files[0];if(!file)return;const label=input.closest('.branding-upload');label.textContent='Enviando…';label.classList.add('disabled');try{const fd=new FormData();fd.append('file',file);const d=await apiForm(`/api/developer/site-content/images/${input.dataset.siteFile}`,fd);state.site={...state.site,images:d.images};toast('Imagem enviada.')}catch(err){toast(err.message)}finally{renderSiteImages()}}})}
  function formatBytes(bytes){const b=Number(bytes||0);if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';if(b<1073741824)return (b/1048576).toFixed(1)+' MB';return (b/1073741824).toFixed(2)+' GB'}
  function formatDuration(s){s=Number(s||0);if(!s)return '—';if(s<60)return s+'s';const m=Math.floor(s/60),r=s%60;return m+'m'+(r?r+'s':'')}
  function backupTypeLabel(t){return {TENANT_MANUAL:'Manual',TENANT_AUTOMATIC:'Automático',TENANT_PRE_DELETE:'Pré-exclusão',SYSTEM_MANUAL:'Sistema manual',SYSTEM_AUTOMATIC:'Sistema automático'}[t]||t}
  function backupStatusBadge(s){return s==='SUCCESS'?'<span class="status status-paid">Concluído</span>':s==='RUNNING'?'<span class="status status-pending">Em andamento</span>':s==='FAILED'?'<span class="status status-overdue">Falhou</span>':s==='DELETED'?'<span class="status status-canceled">Excluído</span>':'<span class="status">'+esc(s)+'</span>'}
  function restoreStatusBadge(s){return s==='SUCCESS'||s==='ROLLBACK_SUCCESS'?'<span class="status status-paid">Concluída</span>':s==='FAILED'?'<span class="status status-overdue">Falhou</span>':s==='ROLLBACK_FAILED'?'<span class="status status-overdue">Rollback falhou</span>':s==='RUNNING'||s==='ROLLBACK_RUNNING'?'<span class="status status-pending">Em andamento</span>':s==='PENDING'?'<span class="status status-pending">Pendente</span>':'<span class="status">'+esc(s)+'</span>'}
  async function fetchDownload(url){try{const headers={};if(state.token)headers.Authorization='Bearer '+state.token;const r=await fetch(url,{headers});if(!r.ok){if(r.status===404)throw new Error('Arquivo não encontrado.');const d=await r.json().catch(()=>null);throw new Error(d?.error||'Falha ao baixar o backup.')}const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);const cd=r.headers.get('Content-Disposition')||'';const m=cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);a.download=m?m[1]:'backup.zip';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);toast('Backup baixado.')}catch(err){toast(err.message)}}
  function eligibleTenants(){return (Array.isArray(state.tenants)?state.tenants:[]).filter(t=>['ACTIVE','SUSPENDED','TRIAL'].includes(t.status))}
  function backupTenantLabel(b){if(b?.tenant?.name)return `<b>${esc(b.tenant.name)}</b>`;const m=b?.filename?String(b.filename).match(/tenant_\d+_([^-]+)-backup-/):null;return m?`<b>${esc(m[1])}</b> <small class="muted">(empresa removida)</small>`:'<span class="muted">Empresa removida</span>'}
  async function backups(){const previous=$('#bkTenant')?$('#bkTenant').value:'';$('#content').innerHTML=`<div id="storageAlert"></div><div class="toolbar"><select id="bkTenant"><option value="">Todas as empresas</option></select><button id="newBackup" class="primary">Novo backup</button></div><p id="noTenantsNote" class="muted hidden"></p><div id="backupsTable"></div><div class="section-head"><h3>Restaurações</h3></div><div id="restoresTable"></div>`;const select=$('#bkTenant'),newBackupBtn=$('#newBackup'),noTenantsNote=$('#noTenantsNote'),backupsTable=$('#backupsTable'),restoresTable=$('#restoresTable');const fillTenantFilter=(keep)=>{const seen=new Set();let html=`<option value="">Todas as empresas</option>`;eligibleTenants().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'pt')).forEach(t=>{if(seen.has(String(t.id)))return;seen.add(String(t.id));html+=`<option value="${esc(t.id)}">${esc(t.name)}</option>`});select.innerHTML=html;select.value=(keep&&[...select.options].some(o=>o.value===keep))?keep:'';noTenantsNote.textContent=seen.size?'':'Nenhuma empresa cadastrada.';noTenantsNote.classList.toggle('hidden',seen.size>0)};const draw=()=>{const tf=select.value;const rows=(Array.isArray(state.backups)?state.backups:[]).filter(b=>!tf||String(b.tenant?.id)===tf).map(b=>`<tr><td>${backupTenantLabel(b)}</td><td>${esc(backupTypeLabel(b.backup_type))}</td><td>${esc(b.started_at||b.created_at)}</td><td>${backupStatusBadge(b.status)}</td><td>${b.status==='DELETED'?'—':formatBytes(b.size_bytes)}</td><td>${b.asset_file_count??0}</td><td title="${esc(b.sha256||'')}">${b.sha256?esc(b.sha256.slice(0,8)):'—'}</td><td>${formatDuration(b.duration_seconds)}</td><td><div class="row-actions">${b.status==='SUCCESS'?iconBtn('backup','neutral','download',b.id,'Baixar backup')+iconBtn('restore','edit','restore',b.id,'Restaurar backup')+iconBtn('delete','danger','delete',b.id,'Excluir backup'):'—'}</div></td></tr>`);const headers=['Empresa','Tipo','Data','Status','Tamanho','Assets','Hash','Duração','Ações'];backupsTable.innerHTML=rows.length?table(headers,rows):table(headers,[`<tr><td colspan="${headers.length}" class="empty">${tf?'Nenhum backup encontrado para esta empresa.':'Nenhum backup encontrado.'}</td></tr>`])};const drawRestores=()=>{const tf=select.value;const rows=(state.restores||[]).filter(r=>!tf||String(r.tenant?.id)===tf).map(r=>`<tr><td>${r.tenant?`<b>${esc(r.tenant.name)}</b>`:'—'}</td><td>${esc(r.started_at||r.created_at)}</td><td>${esc((r.backup_id||'').slice(0,8))}</td><td>${restoreStatusBadge(r.status)}</td><td>${formatDuration(r.duration_seconds)}</td><td>${r.error_message?`<span class="muted" title="${esc(r.error_message)}">${esc(r.error_message.slice(0,60))}</span>`:'—'}</td><td><div class="row-actions">${['FAILED','ROLLBACK_FAILED'].includes(r.status)?iconBtn('restore','edit','retry',r.id,'Tentar novamente'):'—'}</div></td></tr>`);const headers=['Empresa','Início','Backup','Status','Duração','Erro','Ações'];restoresTable.innerHTML=rows.length?table(headers,rows):table(headers,[`<tr><td colspan="${headers.length}" class="empty">${tf?'Nenhuma restauração encontrada para esta empresa.':'Nenhuma restauração encontrada.'}</td></tr>`])};const loadStorage=async()=>{const box=$('#storageAlert');if(!box)return;try{renderStorageAlert(box,await api('/api/developer/backups/storage'))}catch{box.innerHTML=''}};const reloadBackups=async()=>{try{state.backups=await api('/api/developer/backups')}catch{toast('Não foi possível carregar os backups.')}draw()};const reloadRestores=async()=>{try{state.restores=await api('/api/developer/restores')}catch{toast('Não foi possível carregar as restaurações.')}drawRestores()};const runBackup=async(tenantId,btn,idleLabel)=>{btn.disabled=true;btn.textContent='Gerando…';try{const run=await api(`/api/developer/tenants/${tenantId}/backup`,{method:'POST'});toast('Backup criado com sucesso.');await reloadBackups();if(run.status==='SUCCESS'&&confirm('Backup concluído. Deseja baixar agora?'))fetchDownload(`/api/developer/backups/${run.id}/download`)}catch(err){toast('Falha ao criar backup: '+err.message);throw err}finally{btn.disabled=false;btn.textContent=idleLabel}};const openNewBackupModal=()=>{const opts=eligibleTenants().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'pt'));if(!opts.length)return toast('Nenhuma empresa cadastrada.');$('#modalBody').innerHTML=`<h2>Novo backup</h2><p class="muted">O backup é gerado localmente, com banco consistente e os assets da empresa.</p><form id="newBackupForm" class="grid-form"><label>Empresa<select name="tenant_id" required>${opts.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">Gerar backup</button></div></form>`;openModal();$('#newBackupForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#newBackupForm').onsubmit=async e=>{e.preventDefault();const raw=Object.fromEntries(new FormData(e.target));if(!raw.tenant_id)return toast('Selecione uma empresa para gerar o backup.');const btn=e.submitter;try{await runBackup(raw.tenant_id,btn,'Gerar backup');$('#modal').close()}catch{}}};select.onchange=()=>{draw();drawRestores()};newBackupBtn.onclick=()=>{const tf=select.value;if(tf)return runBackup(tf,newBackupBtn,'Novo backup').catch(()=>{});openNewBackupModal()};backupsTable.onclick=backupAction;restoresTable.onclick=restoreAction;(async()=>{try{state.tenants=await api('/api/developer/tenants')}catch{toast('Não foi possível carregar as empresas.')}fillTenantFilter(previous)})();Promise.all([loadStorage(),reloadBackups(),reloadRestores()])}
  function renderStorageAlert(box,s){const b=s.disk,bs=s.backups_size_bytes;const size=`Backups ocupam ${formatBytes(bs)} no disco.`;let html=`<div class="storage-banner ok"><span>${size}</span></div>`;if(b){if(b.level==='critical'){html=`<div class="storage-banner critical"><b>Espaço crítico no disco (${b.used_percent}% em uso).</b> Baixe cópias e remova backups antigos — novos backups podem ser impedidos. ${size}</div>`}else if(b.level==='warning'){html=`<div class="storage-banner warn"><b>Atenção: disco com ${b.used_percent}% em uso.</b> Considere baixar cópias e apagar backups antigos. ${size}</div>`}else{html=`<div class="storage-banner ok"><span>Disco em uso: ${b.used_percent}% · Livre: ${formatBytes(b.free_bytes)} · ${size}</span></div>`}}box.innerHTML=html}
  async function backupAction(e){const b=e.target.closest('[data-action]');if(!b)return;const id=b.dataset.id;const backup=state.backups.find(x=>String(x.id)===id);if(!backup)return;try{if(b.dataset.action==='download')return fetchDownload(`/api/developer/backups/${id}/download`);if(b.dataset.action==='restore')return openRestoreConfirm(backup);if(b.dataset.action==='delete'){if(!confirm(`Excluir o backup de ${backup.tenant?.name||'empresa removida'} (${formatBytes(backup.size_bytes)})?`))return;await api(`/api/developer/backups/${id}`,{method:'DELETE'});toast('Backup excluído.');await backups()}}catch(err){toast(err.message)}}
  function openRestoreConfirm(backup){$('#modalBody').innerHTML=`<h2>Restaurar backup</h2><p>Isso vai substituir <b>todos</b> os dados atuais de <b>${esc(backup.tenant?.name||'empresa')}</b> pelos dados deste backup de ${esc(backup.started_at||backup.created_at||'data desconhecida')}. Durante a operação a empresa fica em manutenção (acesso bloqueado) e um backup de segurança é gerado automaticamente antes da troca.</p><form id="restoreForm" class="grid-form"><label class="wide">Digite <b>RESTAURAR</b> para confirmar<input name="confirmation" autocomplete="off" required></label><div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary danger" type="submit">Restaurar backup</button></div></form>`;openModal();$('#restoreForm').querySelector('[data-close]').onclick=()=>$('#modal').close();$('#restoreForm').onsubmit=async e=>{e.preventDefault();const raw=Object.fromEntries(new FormData(e.target));if(raw.confirmation!=='RESTAURAR')return toast('Digite exatamente RESTAURAR para confirmar.');const btn=e.submitter;btn.disabled=true;btn.textContent='Restaurando…';state.modalLocked=true;const closeBtn=$('#modalClose');if(closeBtn)closeBtn.disabled=true;try{await api(`/api/developer/backups/${backup.id}/restore`,{method:'POST'});$('#modal').close();toast('Restauração concluída com sucesso.');await backups()}catch(err){$('#modal').close();toast(err.message)}finally{state.modalLocked=false;if(closeBtn)closeBtn.disabled=false}}}
  async function restoreAction(e){const b=e.target.closest('[data-action]');if(!b)return;if(b.dataset.action!=='retry')return;const r=(state.restores||[]).find(x=>String(x.id)===b.dataset.id);if(!r)return;if(!confirm(`Tentar novamente a restauração ${r.id.slice(0,8)}? A empresa fica em manutenção durante a operação.`))return;b.disabled=true;try{await api(`/api/developer/restores/${r.id}`,{method:'POST'});toast('Nova restauração iniciada.');await backups()}catch(err){toast(err.message)}finally{b.disabled=false}}
  async function settings(){const s=await api('/api/developer/settings');$('#environment').textContent=s.node_env;$('#content').innerHTML=`<div class="panel"><h2>${esc(s.platform_name)}</h2><p><b>Ambiente:</b> ${esc(s.node_env)}</p><p><b>Armazenamento:</b> ${esc(s.storage)}</p><p><b>Domínio da plataforma:</b> ${esc(s.platform_domain||'Não configurado')}</p><p><b>Tenant padrão:</b> ${esc(s.default_tenant_slug)}</p></div><div class="section-head"><h3>Identidade Visual — PapiCore</h3></div><div class="panel"><p class="muted">Logo e favicon exibidos na tela de login deste painel (papicore.com.br/desenvolvedor).</p><div class="branding-grid"><div id="loginLogoBox" class="muted">Carregando…</div><div id="loginFaviconBox" class="muted">Carregando…</div></div></div><div class="section-head"><h3>Integração de e-mail (Brevo)</h3></div><div class="panel"><p class="muted">Usada para enviar o link de recuperação de senha do painel administrativo dos tenants (/admin). Sem isso habilitado e configurado, o link só é registrado no console em ambiente de desenvolvimento — nenhum e-mail é enviado.</p><div id="emailSettingsBox" class="muted">Carregando…</div></div>`;loadLoginLogo();loadLoginFavicon();loadEmailSettings()}
  async function loadLoginLogo(){const box=$('#loginLogoBox');if(!box)return;try{const d=await api('/api/developer/settings/login-logo');renderLoginAsset('logo',d)}catch(err){box.classList.remove('muted');box.innerHTML=`<p class="error">${esc(err.message)}</p>`}}
  async function loadLoginFavicon(){const box=$('#loginFaviconBox');if(!box)return;try{const d=await api('/api/developer/settings/login-favicon');renderLoginAsset('favicon',d)}catch(err){box.classList.remove('muted');box.innerHTML=`<p class="error">${esc(err.message)}</p>`}}
  async function loadEmailSettings(){const box=$('#emailSettingsBox');if(!box)return;try{const s=await api('/api/developer/settings/email');box.classList.remove('muted');box.innerHTML=`<form id="emailSettingsForm" class="grid-form">
      <label class="switch-row" style="grid-column:1/-1;"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}><span>Habilitar envio de e-mails (Brevo)</span></label>
      <label>Chave da API (Brevo)<input name="brevo_api_key" type="password" autocomplete="new-password" placeholder="${s.has_api_key?esc(s.api_key_preview)+' — deixe em branco para manter':'Cole a chave da API aqui'}"></label>
      <label>E-mail do remetente<input name="brevo_sender_email" type="email" value="${esc(s.brevo_sender_email||'')}" placeholder="nao-responda@papicore.com.br"></label>
      <label>Nome do remetente<input name="brevo_sender_name" value="${esc(s.brevo_sender_name||'')}" placeholder="PapiCore"></label>
      <div class="actions wide"><button class="primary" type="submit">Salvar</button></div>
    </form>`;$('#emailSettingsForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));await api('/api/developer/settings/email',{method:'PUT',body:JSON.stringify({enabled:raw.enabled==='on',brevo_api_key:raw.brevo_api_key,brevo_sender_email:raw.brevo_sender_email,brevo_sender_name:raw.brevo_sender_name})});toast('Configuração de e-mail atualizada.');loadEmailSettings()}catch(err){toast(err.message)}finally{btn.disabled=false}}}catch(err){box.classList.remove('muted');box.innerHTML=`<p class="error">${esc(err.message)}</p>`}}
  function refreshPageFavicon(){const l=document.getElementById('pageFavicon');if(l)l.href='/api/developer/login-favicon?v='+Date.now()}
  async function reloadLoginAssets(){loadLoginLogo();loadLoginFavicon();refreshPageFavicon()}
  function renderLoginAsset(kind,d){const box=$(kind==='logo'?'#loginLogoBox':'#loginFaviconBox');if(!box)return;const has=kind==='logo'?Boolean(d&&d.has_logo):Boolean(d&&d.has_favicon);const name=kind==='logo'?'Logo':'Favicon';const meta=kind==='logo'?'PNG, JPG ou WEBP (máx 3 MB)':'PNG ou ICO (máx 1 MB)';const src=kind==='logo'?(has?d.logo_url:'/assets/logo.png'):(has?d.favicon_url:'/assets/favicon.png');const accept=kind==='logo'?'.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp':'.png,.ico,image/png,image/x-icon,image/vnd.microsoft.icon';box.classList.remove('muted');box.innerHTML=`<div class="branding-card"><div class="branding-preview"><img src="${esc(src)}" alt="${name} da tela de login"></div><p class="muted">${name} — ${meta}</p><div class="branding-actions">${has?`<button type="button" data-login-remove="${kind}" class="danger">Remover</button>`:''}<label class="branding-upload">${has?'Substituir':'Enviar '+name.toLowerCase()}<input type="file" data-login-file="${kind}" accept="${accept}" hidden></label></div></div>`;const removeBtn=box.querySelector(`[data-login-remove="${kind}"]`);if(removeBtn)removeBtn.onclick=async()=>{try{await api(`/api/developer/settings/login-${kind}`,{method:'DELETE'});toast(name+' removida.');reloadLoginAssets()}catch(err){toast(err.message)}};const input=box.querySelector(`[data-login-file="${kind}"]`);input.onchange=async()=>{const file=input.files[0];if(!file)return;const label=input.closest('.branding-upload');const original=label.textContent;label.textContent='Enviando…';label.classList.add('disabled');try{const fd=new FormData();fd.append('file',file);await apiForm(`/api/developer/settings/login-${kind}`,fd);toast(name+' enviada.')}catch(err){toast(err.message)}finally{label.textContent=original;label.classList.remove('disabled');input.value='';reloadLoginAssets()}}}
  /* ---------- Aba "Evolution API" (WhatsApp) ---------- */
  const EVO_STATUS_LABELS={connected:'Conectado',connecting:'QR pendente',disconnected:'Desconectado',error:'Erro',missing_remote:'Faltando na Evolution'};
  const EVO_STATUS_CLASS={connected:'status-paid',connecting:'status-pending',disconnected:'status-canceled',error:'status-overdue',missing_remote:'status-overdue'};
  function evoStatusBadge(s){return `<span class="status ${EVO_STATUS_CLASS[s]||''}">${EVO_STATUS_LABELS[s]||esc(s)}</span>`}
  async function evolution(){
    const data=await api('/api/developer/whatsapp');
    state.evolution=data;
    const mock=data.whatsapp&&data.whatsapp.mock;
    const modeBadge=mock?'<span class="status status-pending">Modo simulação</span>':`<span class="status status-paid">Envio real ativo (${esc(data.whatsapp?.provider||'evolution')})</span>`;
    $('#content').innerHTML=`
      <div class="form-section">
        <h3>Integração WhatsApp — Evolution API</h3>
        <p class="muted">Configure a URL do servidor Evolution e a API key. Com a integração ativa, cada empresa conecta o próprio WhatsApp (1 QR Code por empresa) e as mensagens automáticas passam a ser enviadas de verdade.</p>
        <p class="muted" style="margin-top:0;">Status atual do envio: ${modeBadge}</p>
        <form id="evoSettingsForm" class="grid-form">
          <label>URL do servidor Evolution<input name="server_url" value="${esc(data.server_url)}" placeholder="https://evo.seudominio.com.br"></label>
          <label>API key<input name="api_key" type="password" autocomplete="new-password" placeholder="${data.api_key?'Chave salva — deixe em branco para manter':'Cole a API key aqui'}"></label>
          <label class="wide" style="display:flex;align-items:center;gap:8px;margin:6px 0;"><input type="checkbox" name="enabled" style="width:auto;" ${data.enabled?'checked':''}><span>Habilitar envio real pelo WhatsApp (Evolution)</span></label>
          <div class="actions wide">
            <button type="button" class="ghost" id="evoTest">Testar conexão</button>
            <button class="primary" type="submit">Salvar configuração</button>
          </div>
        </form>
        <div id="evoTestResult"></div>
      </div>
      <div class="section-head"><h3>Conexões por empresa</h3></div>
      <div id="evoInstancesTable"></div>
    `;
    renderEvoInstances(data.instances||[]);
    $('#evoInstancesTable').onclick=evoAction;
    $('#evoSettingsForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));await api('/api/developer/whatsapp/settings',{method:'PUT',body:JSON.stringify({enabled:raw.enabled==='on',server_url:raw.server_url,api_key:raw.api_key})});toast('Configuração salva.');evolution()}catch(err){toast(err.message)}finally{btn.disabled=false}};
    $('#evoTest').onclick=async()=>{const box=$('#evoTestResult');const raw=Object.fromEntries(new FormData($('#evoSettingsForm')));box.innerHTML='<span class="muted">Testando…</span>';try{const r=await api('/api/developer/whatsapp/test-connection',{method:'POST',body:JSON.stringify({server_url:raw.server_url,api_key:raw.api_key})});box.innerHTML=r.ok?`<span class="status status-paid">Servidor acessível${r.instances&&r.instances.length?` — ${r.instances.length} instância(s) encontrada(s)`:' — sem instâncias ainda'}</span>`:`<span class="status status-overdue">Falha na conexão</span> <span class="muted">${esc(r.message)}</span>`}catch(err){box.innerHTML=`<span class="status status-overdue">Falha</span> <span class="muted">${esc(err.message)}</span>`}};
  }
  function renderEvoInstances(instances){
    const rows=(instances||[]).map(i=>`<tr>
      <td><b>${esc(i.name)}</b><br><small class="muted">${esc(i.slug||i.database_name||'')}</small></td>
      <td><code>${esc(i.instance_name)}</code></td>
      <td>${evoStatusBadge(i.status)}${i.last_error?`<br><small class="muted" title="${esc(i.last_error)}">${esc(i.last_error.length>40?i.last_error.slice(0,40)+'…':i.last_error)}</small>`:''}</td>
      <td>${i.owner_number?esc(i.owner_number):'—'}</td>
      <td><div class="row-actions">
        ${i.status==='connected'?`<button type="button" class="action-btn action-btn-neutral" data-evo-action="reconnect" data-tenant-id="${i.tenant_id}" title="Reconectar (novo QR)" aria-label="Reconectar">${ICONS.restore}</button>`:''}
        ${i.status==='connecting'&&i.qr_base64?`<button type="button" class="action-btn action-btn-edit" data-evo-action="qr" data-tenant-id="${i.tenant_id}" title="Ver QR Code" aria-label="Ver QR Code">${ICONS.detail}</button>`:''}
        ${i.status==='disconnected'||i.status==='error'||i.status==='missing_remote'?`<button type="button" class="action-btn action-btn-success" data-evo-action="connect" data-tenant-id="${i.tenant_id}" title="Conectar (gerar QR)" aria-label="Conectar">${ICONS.accept}</button>`:''}
        ${i.status==='connected'||i.status==='connecting'?`<button type="button" class="action-btn action-btn-warn" data-evo-action="disconnect" data-tenant-id="${i.tenant_id}" title="Desconectar" aria-label="Desconectar">${ICONS.cancel}</button>`:''}
      </div></td>
    </tr>`);
    $('#evoInstancesTable').innerHTML=table(['Empresa','Instância','Status','Número','Ações'],rows);
  }
  async function evoAction(e){
    const b=e.target.closest('[data-evo-action]');if(!b)return;
    const id=b.dataset.tenantId,action=b.dataset.evoAction;
    const data=state.evolution||{};
    const inst=(data.instances||[]).find(x=>String(x.tenant_id)===id)||{};
    try{
      if(action==='qr'){
        const conn=await api(`/api/developer/whatsapp/tenants/${id}`);
        if(!conn.qr)return toast('Nenhum QR pendente. Clique em "Conectar" para gerar um novo.');
        $('#modalBody').innerHTML=`<h2>QR Code — ${esc(inst.name||'')}</h2><div style="text-align:center;padding:14px 0;"><img src="${esc(conn.qr)}" alt="QR Code do WhatsApp" style="width:240px;height:240px;background:#fff;padding:8px;border:1px solid var(--line);border-radius:10px;"></div><p class="muted">Escaneie com WhatsApp &gt; Aparelhos conectados. O código expira em poucos minutos.</p><div class="actions"><button type="button" data-close>Fechar</button></div>`;
        openModal();$('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();return;
      }
      if(action==='disconnect'){if(!confirm(`Desconectar o WhatsApp da empresa "${inst.name||id}"?`))return;}
      if(action==='connect'||action==='reconnect'){
        await api(`/api/developer/whatsapp/tenants/${id}/${action}`,{method:'POST'});
        toast('QR Code gerado. Abra em "Ver QR Code" ou peça ao cliente para escanear no painel.');
      }else if(action==='disconnect'){
        await api(`/api/developer/whatsapp/tenants/${id}/disconnect`,{method:'POST'});
        toast('WhatsApp desconectado.');
      }
      evolution();
    }catch(err){toast(err.message)}
  }

  /* ---------- Aba "API" ---------- */
  const API_TABS=[['overview','Visão geral'],['endpoints','Endpoints'],['keys','Chaves de API'],['webhooks','Webhooks'],['logs','Logs']];
  const API_KEY_STATUS_LABELS={ACTIVE:'Ativa',REVOKED:'Revogada',EXPIRED:'Expirada',SUSPENDED:'Suspensa'};
  const API_SCOPE_LABELS={'settings:read':'Configurações','catalog:read':'Catálogo','availability:read':'Disponibilidade','appointments:read':'Agendamentos (leitura)','appointments:write':'Agendamentos (escrita)','customers:read':'Clientes','packages:read':'Pacotes'};
  const API_WEBHOOK_EVENT_LABELS={'appointment.created':'Agendamento criado','appointment.updated':'Agendamento atualizado','appointment.completed':'Agendamento concluído','appointment.cancelled':'Agendamento cancelado','package.sold':'Pacote vendido'};
  function apiKeyStatusBadge(s){const map={ACTIVE:'status-paid',REVOKED:'status-canceled',EXPIRED:'status-overdue',SUSPENDED:'status-pending'};return `<span class="status ${map[s]||''}">${API_KEY_STATUS_LABELS[s]||esc(s)}</span>`}
  function apiWebhookStatusBadge(a){return a?'<span class="status status-paid">Ativo</span>':'<span class="status status-canceled">Inativo</span>'}
  function apiScopeChips(scopes){return (scopes||[]).map(s=>`<span class="chip">${esc(API_SCOPE_LABELS[s]||s)}</span>`).join(' ')}
  function apiEventChips(events){return (events||[]).map(e=>`<span class="chip">${esc(API_WEBHOOK_EVENT_LABELS[e]||e)}</span>`).join(' ')}
  function apiDatetime(v){return v?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'—'}

  async function apiView(){
    const activeTab=state.apiTab||'overview';
    $('#content').innerHTML=`<div class="tabs">${API_TABS.map(([id,label])=>`<button type="button" data-atab="${id}" class="${id===activeTab?'active':''}">${esc(label)}</button>`).join('')}</div><div id="apiBody"></div>`;
    $('#content').querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-atab]');if(!b)return;state.apiTab=b.dataset.atab;apiView()};
    const bodyEl=$('#apiBody');
    if(activeTab==='overview')return renderApiOverview(bodyEl);
    if(activeTab==='endpoints')return renderApiEndpoints(bodyEl);
    if(activeTab==='webhooks')return renderApiWebhooks(bodyEl);
    if(activeTab==='logs')return renderApiLogs(bodyEl);
    return renderApiKeys(bodyEl);
  }

  async function renderApiEndpoints(bodyEl){
    let spec;
    try{spec=await (await fetch('/api/v1/openapi.json')).json();}
    catch(e){bodyEl.innerHTML='<div class="panel error">Não foi possível carregar a documentação da API.</div>';return}
    const rows=[];
    for(const [path,item] of Object.entries(spec.paths||{})){
      for(const [method,op] of Object.entries(item||{})){
        if(!['get','post','put','patch','delete'].includes(method))continue;
        const scope=(op.security&&op.security[0]&&op.security[0].bearerAuth)||[];
        const fullRoute='/api/v1'+path.replace(/\{([^}]+)\}/g,':$1');
        const desc=op.summary||op.description||'';
        const detail=(op.description&&op.description!==op.summary)?op.description:'';
        rows.push(`<tr>
          <td><span class="method method-${method}">${method.toUpperCase()}</span></td>
          <td><code class="route">${esc(fullRoute)}</code></td>
          <td><b>${esc(desc)}</b>${detail?`<br><small class="muted">${esc(detail)}</small>`:''}</td>
          <td>${apiScopeChips(scope)}</td>
          <td><div class="row-actions">
            <button type="button" class="action-btn action-btn-neutral" data-copy-route="${esc(method.toUpperCase()+' '+fullRoute)}" data-copy-desc="${esc(desc)}" title="Copiar rota e descrição" aria-label="Copiar rota e descrição">${ICONS.copy}</button>
          </div></td>
        </tr>`);
      }
    }
    bodyEl.innerHTML=`
      <div class="toolbar"><a class="primary" style="width:auto;text-decoration:none;" href="/api/v1/openapi.json" target="_blank" rel="noopener">Abrir especificação OpenAPI (JSON)</a></div>
      <p class="muted">Todas as rotas usam <code>Authorization: Bearer &lt;chave&gt;</code>. Requisições de escrita (POST) exigem o cabeçalho <code>Idempotency-Key</code>. Clique no ícone de copiar para levar a rota e a descrição a outra ferramenta/IA.</p>
      ${table(['Método','Rota','O que faz','Escopo','Ações'],rows)}`;
    bodyEl.querySelector('.table-wrap').onclick=e=>{
      const b=e.target.closest('[data-copy-route]');if(!b)return;
      copyText(`${b.dataset.copyRoute}\nO que faz: ${b.dataset.copyDesc||''}`);
    };
  }

  async function renderApiOverview(bodyEl){
    const d=await api('/api/developer/api/overview');
    const cards=[['Chaves de API',d.keys_count],['Webhooks',d.webhooks_count],['Webhooks pendentes',d.pending_webhooks],['Empresas com chave',d.tenants_with_keys],['Empresas',d.tenant_count]];
    const reqRows=(d.recent_requests||[]).map(r=>`<tr><td>${apiDatetime(r.created_at)}</td><td><code>${esc(r.method)}</code></td><td><code>${esc(r.path)}</code></td><td><span class="status ${r.status_code<400?'status-paid':'status-overdue'}">${r.status_code}</span></td><td>${r.tenant_name?esc(r.tenant_name):'—'}</td></tr>`);
    const webRows=(d.recent_webhooks||[]).map(w=>`<tr><td>${apiDatetime(w.created_at)}</td><td>${esc(w.event)}</td><td>${esc(w.status)}</td><td>${w.attempts}</td><td><code>${esc(w.webhook_url||'')}</code></td></tr>`);
    bodyEl.innerHTML=`
      <section class="cards">${cards.map(c=>`<article class="card"><span class="muted">${c[0]}</span><strong>${c[1]??0}</strong></article>`).join('')}</section>
      <div class="panel"><h2>Escopos disponíveis</h2><p class="muted">Cada chave pode combinar escopos de leitura e escrita. A chave nunca é exibida novamente depois da criação.</p><div class="chips">${apiScopeChips(d.scopes)}</div></div>
      <div class="section-head"><h3>Eventos de webhook</h3></div>
      <div class="panel">${apiEventChips(d.webhook_events)}</div>
      <div class="section-head"><h3>Requisições recentes</h3></div>
      ${table(['Data','Método','Rota','Status','Empresa'],reqRows)}
      <div class="section-head"><h3>Entregas de webhook recentes</h3></div>
      ${table(['Data','Evento','Status','Tentativas','URL'],webRows)}
    `;
  }

  async function loadApiBase(){
    const [keys,webhooks,tenants]=await Promise.all([api('/api/developer/api/keys'),api('/api/developer/api/webhooks'),api('/api/developer/tenants')]);
    state.apiKeys=keys;state.apiWebhooks=webhooks;state.tenants=tenants;
  }

  async function renderApiKeys(bodyEl){
    await loadApiBase();
    const rows=(state.apiKeys||[]).map(k=>{
      const t=(state.tenants||[]).find(x=>x.id===k.tenant_id)||{};
      return `<tr>
        <td><code>${esc(k.key_prefix)}…</code><br><small class="muted">${esc(k.name)}</small></td>
        <td>${esc(t.name||k.tenant_id)}</td>
        <td>${apiScopeChips(k.scopes)}</td>
        <td>${apiKeyStatusBadge(k.status)}</td>
        <td>${k.expires_at?date(k.expires_at):'Sem expiração'}</td>
        <td>${apiDatetime(k.last_used_at)}</td>
        <td><div class="row-actions">
          <button type="button" class="action-btn action-btn-warn" data-apiaction="rotate" data-id="${k.id}" title="Rotacionar chave" aria-label="Rotacionar chave">${ICONS.restore}</button>
          <button type="button" class="action-btn action-btn-edit" data-apiaction="edit" data-id="${k.id}" title="Editar chave" aria-label="Editar chave">${ICONS.edit}</button>
          <button type="button" class="action-btn action-btn-danger" data-apiaction="delete" data-id="${k.id}" title="Excluir chave" aria-label="Excluir chave">${ICONS.delete}</button>
        </div></td>
      </tr>`;
    });
    bodyEl.innerHTML=`
      <div class="toolbar"><button id="newApiKey" class="primary">Nova chave de API</button></div>
      <p class="muted">As chaves identificam o tenant automaticamente no cabeçalho <code>Authorization: Bearer pk_live_...</code>. A chave completa é exibida apenas uma vez, ao criar ou rotacionar.</p>
      ${table(['Chave','Empresa','Escopos','Status','Expiração','Último uso','Ações'],rows)}`;
    $('#newApiKey').onclick=()=>openApiKeyForm();
    bodyEl.querySelector('.table-wrap').onclick=e=>{const b=e.target.closest('[data-apiaction]');if(b)apiKeyAction(b)};
  }

  async function apiKeyAction(btn){
    const id=btn.dataset.id,action=btn.dataset.apiaction;
    const key=(state.apiKeys||[]).find(k=>String(k.id)===id)||{};
    try{
      if(action==='rotate'){if(!confirm(`Rotacionar a chave "${key.name||''}"? A chave atual deixará de funcionar imediatamente.`))return;const d=await api(`/api/developer/api/keys/${id}/rotate`,{method:'POST'});showSecretModal('Nova chave de API',d.api_key,`Guarde agora. Não será possível exibi-la novamente.`);return}
      if(action==='delete'){if(!confirm(`Excluir a chave "${key.name||''}"?`))return;await api(`/api/developer/api/keys/${id}`,{method:'DELETE'});toast('Chave excluída.');return}
      if(action==='edit')return openApiKeyForm(key);
    }catch(err){toast(err.message)}finally{if(action!=='edit')apiView()}
  }

  function openApiKeyForm(key){
    const isEdit=Boolean(key&&key.id);
    const tenantOptions=state.tenants.map(t=>`<option value="${t.id}" ${key&&key.tenant_id===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
    $('#modalBody').innerHTML=`
      <h2>${isEdit?'Editar chave de API':'Nova chave de API'}</h2>
      <form id="apiKeyForm" class="grid-form">
        <label class="wide">Nome<input name="name" value="${esc(key?.name||'')}" placeholder="Ex.: Integração do site"></label>
        <label class="wide">Empresa<select name="tenant_id" ${isEdit?'disabled':''}>${tenantOptions}</select></label>
        <label class="wide" style="align-items:flex-start;">Escopos<span id="scopeBox" class="checkbox-group">${ALL_SCOPES_UI(key?.scopes)}</span></label>
        <label class="wide">Expiração (opcional)<input name="expires_at" type="date" value="${esc(key?.expires_at||'')}"></label>
        ${isEdit?`<label class="wide">Status<select name="status">${['ACTIVE','SUSPENDED','REVOKED'].map(s=>`<option ${key.status===s?'selected':''}>${s}</option>`).join('')}</select></label>`:''}
        <div class="actions wide"><button type="submit" class="primary">${isEdit?'Salvar':'Criar chave'}</button><button type="button" data-close>Cancelar</button></div>
      </form>`;
    openModal();
    $('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();
    $('#apiKeyForm').onsubmit=async e=>{
      e.preventDefault();const btn=e.submitter;btn.disabled=true;
      const raw=Object.fromEntries(new FormData(e.target));
      const payload={name:raw.name,scopes:Array.from($('#scopeBox').querySelectorAll('input:checked')).map(c=>c.value)};
      if(isEdit){if(raw.status)payload.status=raw.status;payload.expires_at=raw.expires_at||null;}
      else{payload.tenant_id=Number(state.tenants.find(t=>String(t.id)===String(raw.tenant_id))?.id);payload.expires_at=raw.expires_at||null;}
      try{
        if(isEdit){await api(`/api/developer/api/keys/${key.id}`,{method:'PATCH',body:JSON.stringify(payload)});toast('Chave atualizada.');$('#modal').close();}
        else{const d=await api('/api/developer/api/keys',{method:'POST',body:JSON.stringify(payload)});$('#modal').close();showSecretModal('Chave de API criada',d.api_key,'Use esta chave no cabeçalho Authorization das requisições à API pública. Ela não será exibida novamente.')}
      }catch(err){toast(err.message)}finally{btn.disabled=false}
    };
  }

  async function renderApiWebhooks(bodyEl){
    await loadApiBase();
    const rows=(state.apiWebhooks||[]).map(w=>{
      const t=(state.tenants||[]).find(x=>x.id===w.tenant_id)||{};
      return `<tr>
        <td><b>${esc(w.name)}</b><br><small class="muted">${esc(t.name||w.tenant_id)}</small></td>
        <td><code>${esc(w.url)}</code></td>
        <td>${apiEventChips(w.events)}</td>
        <td>${apiWebhookStatusBadge(w.active)}</td>
        <td><div class="row-actions">
          <button type="button" class="action-btn action-btn-success" data-apiwaction="test" data-id="${w.id}" title="Enviar teste" aria-label="Enviar teste">${ICONS.detail}</button>
          <button type="button" class="action-btn action-btn-edit" data-apiwaction="edit" data-id="${w.id}" title="Editar webhook" aria-label="Editar webhook">${ICONS.edit}</button>
          <button type="button" class="action-btn action-btn-danger" data-apiwaction="delete" data-id="${w.id}" title="Excluir webhook" aria-label="Excluir webhook">${ICONS.delete}</button>
        </div></td>
      </tr>`;
    });
    bodyEl.innerHTML=`
      <div class="toolbar"><button id="newWebhook" class="primary">Novo webhook</button></div>
      <p class="muted">O PapiCore assina cada entrega com HMAC-SHA256 no cabeçalho <code>X-PapiCore-Signature: sha256=&lt;hex&gt;</code> usando o secret exibido uma única vez na criação. Falhas são tentadas de novo com backoff exponencial.</p>
      ${table(['Webhook','URL','Eventos','Status','Ações'],rows)}`;
    $('#newWebhook').onclick=()=>openWebhookForm();
    bodyEl.querySelector('.table-wrap').onclick=e=>{const b=e.target.closest('[data-apiwaction]');if(b)apiWebhookAction(b)};
  }

  async function apiWebhookAction(btn){
    const id=btn.dataset.id,action=btn.dataset.apiwaction;
    const wh=(state.apiWebhooks||[]).find(w=>String(w.id)===id)||{};
    try{
      if(action==='test'){const r=await api(`/api/developer/api/webhooks/${id}/test`,{method:'POST'});if(r.delivered)toast('Webhook entregue com sucesso no teste.');else toast(r.error||'Teste falhou.');return}
      if(action==='delete'){if(!confirm(`Excluir o webhook "${wh.name||''}"?`))return;await api(`/api/developer/api/webhooks/${id}`,{method:'DELETE'});toast('Webhook excluído.');return}
      if(action==='edit')return openWebhookForm(wh);
    }catch(err){toast(err.message)}finally{if(action!=='edit')apiView()}
  }

  function openWebhookForm(wh){
    const isEdit=Boolean(wh&&wh.id);
    const tenantOptions=state.tenants.map(t=>`<option value="${t.id}" ${wh&&wh.tenant_id===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
    $('#modalBody').innerHTML=`
      <h2>${isEdit?'Editar webhook':'Novo webhook'}</h2>
      <form id="webhookForm" class="grid-form">
        <label class="wide">Nome<input name="name" value="${esc(wh?.name||'')}" placeholder="Ex.: Notificações do sistema"></label>
        <label class="wide">Empresa<select name="tenant_id" ${isEdit?'disabled':''}>${tenantOptions}</select></label>
        <label class="wide">URL de destino<input name="url" value="${esc(wh?.url||'')}" placeholder="https://seu-servidor.com.br/hooks/papi"></label>
        <label class="wide" style="align-items:flex-start;">Eventos<span id="webhookEventBox" class="checkbox-group">${ALL_WEBHOOK_EVENTS_UI(wh?.events)}</span></label>
        ${isEdit?`<label class="wide" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" name="active" style="width:auto;" ${wh.active?'checked':''}><span>Webhook ativo</span></label>`:''}
        <div class="actions wide"><button type="submit" class="primary">${isEdit?'Salvar':'Criar webhook'}</button><button type="button" data-close>Cancelar</button></div>
      </form>`;
    openModal();
    $('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();
    $('#webhookForm').onsubmit=async e=>{
      e.preventDefault();const btn=e.submitter;btn.disabled=true;
      const raw=Object.fromEntries(new FormData(e.target));
      const payload={name:raw.name,url:raw.url,events:Array.from($('#webhookEventBox').querySelectorAll('input:checked')).map(c=>c.value)};
      if(isEdit){payload.active=raw.active==='on';}
      else{payload.tenant_id=Number(state.tenants.find(t=>String(t.id)===String(raw.tenant_id))?.id);payload.active=true;}
      try{
        if(isEdit){await api(`/api/developer/api/webhooks/${wh.id}`,{method:'PUT',body:JSON.stringify(payload)});toast('Webhook atualizado.');$('#modal').close();}
        else{const d=await api('/api/developer/api/webhooks',{method:'POST',body:JSON.stringify(payload)});$('#modal').close();showSecretModal('Secret do webhook',d.secret,'Use este secret para verificar a assinatura HMAC-SHA256 do cabeçalho X-PapiCore-Signature. Ele não será exibido novamente.')}
      }catch(err){toast(err.message)}finally{btn.disabled=false}
    };
  }

  async function renderApiLogs(bodyEl){
    const [whLogs,reqLogs]=await Promise.all([api('/api/developer/api/webhooks/logs?limit=100'),api('/api/developer/api/logs?limit=100')]);
    const whRows=(whLogs||[]).map(w=>`<tr>
      <td>${apiDatetime(w.created_at)}</td>
      <td>${esc(w.event)}</td>
      <td><span class="status ${w.status==='DELIVERED'?'status-paid':w.status==='FAILED'?'status-overdue':'status-pending'}">${esc(w.status)}</span></td>
      <td>${w.attempts}</td>
      <td><code>${esc(w.webhook_url||'')}</code></td>
      <td>${w.last_error?`<small class="muted" title="${esc(w.last_error)}">${esc(w.last_error.length>40?w.last_error.slice(0,40)+'…':w.last_error)}</small>`:'—'}</td>
      <td>${w.status==='FAILED'||w.status==='PENDING'?`<button type="button" class="action-btn action-btn-edit" data-apilogaction="redeliver" data-id="${w.id}" title="Reenviar" aria-label="Reenviar">${ICONS.restore}</button>`:''}</td>
    </tr>`);
    const reqRows=(reqLogs||[]).map(r=>`<tr><td>${apiDatetime(r.created_at)}</td><td><code>${esc(r.method)}</code></td><td><code>${esc(r.path)}</code></td><td><span class="status ${r.status_code<400?'status-paid':'status-overdue'}">${r.status_code}</span></td><td>${r.tenant_name?esc(r.tenant_name):'—'}</td><td>${esc(r.api_key_name||'')}</td><td>${r.duration_ms}ms</td></tr>`);
    bodyEl.innerHTML=`
      <div class="section-head"><h3>Entregas de webhook (outbox)</h3></div>
      <div id="apiWhLogsTable"></div>
      <div class="section-head"><h3>Requisições à API pública</h3></div>
      <div id="apiReqLogsTable"></div>`;
    $('#apiWhLogsTable').innerHTML=table(['Data','Evento','Status','Tentativas','URL','Erro','Ações'],whRows);
    $('#apiReqLogsTable').innerHTML=table(['Data','Método','Rota','Status','Empresa','Chave','Duração'],reqRows);
    $('#apiWhLogsTable').onclick=e=>{const b=e.target.closest('[data-apilogaction]');if(!b)return;apiLogAction(b)};
  }

  async function apiLogAction(btn){
    try{const r=await api(`/api/developer/api/webhooks/outbox/${btn.dataset.id}/redeliver`,{method:'POST'});if(r.delivered)toast('Webhook entregue no reenvio.');else toast(r.error||'Falha no reenvio.');}catch(err){toast(err.message)}finally{apiView()}
  }

  const ALL_SCOPES_UI=selected=>['settings:read','catalog:read','availability:read','appointments:read','appointments:write','customers:read','packages:read'].map(s=>`<label class="checkbox-inline"><input type="checkbox" value="${s}" ${(selected||[]).includes(s)?'checked':''}> ${esc(API_SCOPE_LABELS[s]||s)}</label>`).join('');
  const ALL_WEBHOOK_EVENTS_UI=selected=>['appointment.created','appointment.updated','appointment.completed','appointment.cancelled','package.sold'].map(e=>`<label class="checkbox-inline"><input type="checkbox" value="${e}" ${(selected||[]).includes(e)?'checked':''}> ${esc(API_WEBHOOK_EVENT_LABELS[e]||e)}</label>`).join('');

  function showSecretModal(title,value,hint){
    $('#modalBody').innerHTML=`<h2>${esc(title)}</h2><p class="muted">${esc(hint)}</p><div style="position:relative;margin:12px 0;"><input id="secretValue" readonly value="${esc(value)}" style="font-family:monospace;padding:10px;padding-right:84px;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;background:var(--bg);"><button type="button" id="copySecret" class="action-btn action-btn-edit" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);">Copiar</button></div><div class="actions"><button type="button" data-close>Fechar</button></div>`;
    openModal();
    const copyBtn=$('#copySecret');
    if(copyBtn)copyBtn.onclick=()=>{navigator.clipboard.writeText(value).then(()=>toast('Copiado.')).catch(()=>{})};
    $('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();
  }

  /* ---------- Aba "Contratos" ---------- */
  const CONTRACT_TABS=[['settings','Configurações da contratada'],['templates','Modelos'],['new','Novo contrato'],['history','Contratos gerados']];
  const CONTRACT_TYPE_LABELS={SUBSCRIPTION:'Assinatura',RENEWAL:'Renovação',ADDENDUM:'Aditivo',CANCELLATION:'Distrato',CUSTOM:'Personalizado'};
  const CONTRACT_STATUS_LABELS={DRAFT:'Rascunho',FINALIZED:'Finalizado',CANCELLED:'Cancelado',EXPIRED:'Expirado',REPLACED:'Substituído'};
  const DISCLAIMER_HTML='<div class="disclaimer"><span>⚠️</span><span>Este modelo deve ser revisado por advogado antes de uso comercial definitivo.</span></div>';
  function contractTypeLabel(t){return CONTRACT_TYPE_LABELS[t]||t}
  function contractStatusLabel(s){return CONTRACT_STATUS_LABELS[s]||s}
  function contractStatusBadge(s){const map={DRAFT:'status-pending',FINALIZED:'status-paid',CANCELLED:'status-canceled',EXPIRED:'status-overdue',REPLACED:'status-canceled'};return `<span class="status ${map[s]||''}">${esc(contractStatusLabel(s))}</span>`}

  async function contracts(){
    const [meta,tenantsData,plansData]=await Promise.all([api('/api/developer/contracts/meta'),api('/api/developer/tenants'),api('/api/developer/plans')]);
    state.contractMeta=meta;state.tenants=tenantsData;state.plans=plansData;
    const activeTab=state.contractsTab||'settings';
    $('#content').innerHTML=`<div class="tabs">${CONTRACT_TABS.map(([id,label])=>`<button type="button" data-ctab="${id}" class="${id===activeTab?'active':''}">${esc(label)}</button>`).join('')}</div><div id="contractsBody"></div>`;
    $('#content').querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-ctab]');if(!b)return;state.contractsTab=b.dataset.ctab;contracts()};
    const bodyEl=$('#contractsBody');
    if(activeTab==='settings')return renderContractSettings(bodyEl);
    if(activeTab==='templates')return renderContractTemplates(bodyEl);
    if(activeTab==='new')return renderNewContract(bodyEl);
    return renderContractHistory(bodyEl);
  }

  /* --- Configurações da contratada --- */
  async function renderContractSettings(bodyEl){
    const settings=await api('/api/developer/contracts/company-settings');
    bodyEl.innerHTML=`<div class="panel"><h2>Dados da contratada (PapiCore)</h2><p class="muted">Usados no cabeçalho e nas assinaturas de todo contrato gerado, para qualquer empresa cliente.</p>
      <form id="companySettingsForm" class="grid-form">
        <label>Razão social<input name="legal_name" value="${esc(settings.legal_name||'')}"></label>
        <label>Nome fantasia<input name="trade_name" value="${esc(settings.trade_name||'')}"></label>
        <label>CNPJ/CPF<input name="document" value="${esc(settings.document||'')}"></label>
        <label>E-mail<input name="email" type="email" value="${esc(settings.email||'')}"></label>
        <label>Telefone<input name="phone" value="${esc(settings.phone||'')}"></label>
        <label>Endereço<input name="address" value="${esc(settings.address||'')}"></label>
        <label>Número<input name="address_number" value="${esc(settings.address_number||'')}"></label>
        <label>Complemento<input name="address_complement" value="${esc(settings.address_complement||'')}"></label>
        <label>Bairro<input name="neighborhood" value="${esc(settings.neighborhood||'')}"></label>
        <label>Cidade<input name="city" value="${esc(settings.city||'')}"></label>
        <label>Estado<input name="state" maxlength="2" value="${esc(settings.state||'')}"></label>
        <label>CEP<input name="zip_code" value="${esc(settings.zip_code||'')}"></label>
        <label>Representante legal<input name="legal_representative_name" value="${esc(settings.legal_representative_name||'')}"></label>
        <label>Documento do representante<input name="legal_representative_document" value="${esc(settings.legal_representative_document||'')}"></label>
        <label>Cargo do representante<input name="legal_representative_role" value="${esc(settings.legal_representative_role||'')}"></label>
        <label>Foro padrão<input name="default_jurisdiction" value="${esc(settings.default_jurisdiction||'')}" placeholder="Ex.: Comarca de São Paulo/SP"></label>
        <div class="actions wide"><button class="primary" type="submit">Salvar</button></div>
      </form>
    </div>
    <div class="section-head"><h3>Logo e assinatura para contratos</h3></div>
    <div class="panel"><p class="muted">A logo aparece no cabeçalho do PDF; a assinatura é carimbada sobre a linha "CONTRATADA" — assim o contrato já sai assinado para o cliente baixar.</p><div class="branding-grid"><div id="contractLogoBox"></div><div id="contractSignatureBox"></div></div></div>`;
    renderContractImageBox('logo', 'contractLogoBox', Boolean(settings.has_logo));
    renderContractImageBox('signature', 'contractSignatureBox', Boolean(settings.has_signature));
    $('#companySettingsForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;try{const raw=Object.fromEntries(new FormData(e.target));await api('/api/developer/contracts/company-settings',{method:'PUT',body:JSON.stringify(raw)});toast('Dados da contratada atualizados.')}catch(err){toast(err.message)}finally{btn.disabled=false}};
  }

  const CONTRACT_IMAGE_LABELS={logo:{name:'Logo',empty:'Nenhuma logo enviada',send:'Enviar logo',removed:'Logo removida.',sent:'Logo enviada.'},signature:{name:'Assinatura',empty:'Nenhuma assinatura enviada',send:'Enviar assinatura',removed:'Assinatura removida.',sent:'Assinatura enviada.'}};

  /* Widget de upload de logo/assinatura da contratada — mesmo componente
     para os dois, só troca o endpoint e os textos. */
  async function renderContractImageBox(kind,boxId,hasIt){
    const box=$('#'+boxId);if(!box)return;
    const labels=CONTRACT_IMAGE_LABELS[kind];
    const url=`/api/developer/contracts/company-settings/${kind}`;
    let src=null;
    if(hasIt){try{const headers={};if(state.token)headers.Authorization='Bearer '+state.token;const r=await fetch(url,{headers});if(r.ok){src=URL.createObjectURL(await r.blob())}}catch{/* ignore */}}
    box.innerHTML=`<div class="branding-card"><div class="branding-preview">${src?`<img src="${src}" alt="${labels.name} dos contratos">`:`<span class="branding-placeholder">${labels.empty}</span>`}</div><div class="branding-actions">${hasIt?`<button type="button" data-remove-image class="danger">Remover</button>`:''}<label class="branding-upload">${hasIt?'Substituir':labels.send}<input type="file" data-upload-image hidden accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"></label></div></div>`;
    const removeBtn=box.querySelector('[data-remove-image]');
    if(removeBtn)removeBtn.onclick=async()=>{try{await api(url,{method:'DELETE'});toast(labels.removed);renderContractImageBox(kind,boxId,false)}catch(err){toast(err.message)}};
    box.querySelector('[data-upload-image]').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const fd=new FormData();fd.append('file',file);await apiForm(url,fd);toast(labels.sent);renderContractImageBox(kind,boxId,true)}catch(err){toast(err.message)}};
  }

  /* --- Modelos --- */
  async function renderContractTemplates(bodyEl){
    const all=await api('/api/developer/contract-templates');
    state.contractTemplates=all;
    const families=new Map();
    all.forEach(t=>{const cur=families.get(t.slug);if(!cur||t.version>cur.version)families.set(t.slug,t)});
    all.forEach(t=>{if(t.is_default)families.set(t.slug,t)});
    const rows=[...families.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt'));
    bodyEl.innerHTML=`${DISCLAIMER_HTML}<div class="toolbar"><button id="newTemplate" class="primary">Novo modelo</button></div><div id="templatesTable"></div>`;
    const trows=rows.map(t=>`<tr><td><b>${esc(t.name)}</b><br><small class="muted">${esc(t.slug)}</small></td><td>${esc(contractTypeLabel(t.contract_type))}</td><td>v${t.version}</td><td><span class="status">${t.is_active?'Ativo':'Inativo'}</span></td><td>${esc(t.updated_at)}</td><td><div class="row-actions">${iconBtn('edit','edit','edit',t.id,'Editar (cria nova versão)')}${iconBtn('detail','neutral','versions',t.id,'Ver versões')}${iconBtn('backup','neutral','duplicate',t.id,'Duplicar')}${iconBtn(t.is_active?'cancel':'accept',t.is_active?'warn':'success','toggle',t.id,t.is_active?'Inativar':'Ativar')}</div></td></tr>`);
    $('#templatesTable').innerHTML=table(['Nome','Tipo','Versão padrão','Status','Atualizado em','Ações'],trows);
    $('#newTemplate').onclick=()=>openTemplateEditor();
    $('#templatesTable').onclick=templateAction;
  }

  async function templateAction(e){
    const b=e.target.closest('[data-action]');if(!b)return;
    const t=state.contractTemplates.find(x=>String(x.id)===b.dataset.id);if(!t)return;
    try{
      if(b.dataset.action==='edit')return openTemplateEditor(t);
      if(b.dataset.action==='duplicate'){const name=prompt('Nome do novo modelo (cópia):',`${t.name} (cópia)`);if(!name)return;await api(`/api/developer/contract-templates/${t.id}/duplicate`,{method:'POST',body:JSON.stringify({name})});toast('Modelo duplicado.');contracts();return}
      if(b.dataset.action==='toggle'){if(!confirm(`${t.is_active?'Inativar':'Ativar'} o modelo "${t.name}" (todas as versões)?`))return;await api(`/api/developer/contract-templates/${t.id}/active`,{method:'POST',body:JSON.stringify({is_active:!t.is_active})});toast('Status do modelo atualizado.');contracts();return}
      if(b.dataset.action==='versions')return openTemplateVersions(t.slug);
    }catch(err){toast(err.message)}
  }

  function openTemplateVersions(slug){
    const versions=state.contractTemplates.filter(t=>t.slug===slug).sort((a,b)=>b.version-a.version);
    $('#modalBody').innerHTML=`<h2>Versões — ${esc(versions[0].name)}</h2>${table(['Versão','Status','Atualizado em','Ações'],versions.map(v=>`<tr><td>v${v.version}${v.is_default?' <span class="status status-paid">padrão</span>':''}</td><td>${v.is_active?'Ativo':'Inativo'}</td><td>${esc(v.updated_at)}</td><td><div class="row-actions">${iconBtn('detail','neutral','view',v.id,'Ver conteúdo')}${!v.is_default?iconBtn('star','star','default',v.id,'Marcar como padrão'):''}</div></td></tr>`))}<div class="actions"><button type="button" data-close>Fechar</button></div>`;
    openModal();
    $('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();
    $('#modalBody').onclick=async e=>{
      const b=e.target.closest('[data-action]');if(!b)return;
      const v=versions.find(x=>String(x.id)===b.dataset.id);if(!v)return;
      if(b.dataset.action==='view'){$('#modalBody').innerHTML=`<h2>${esc(v.name)} — v${v.version}</h2><div class="contract-page-wrap"><div class="contract-page">${esc(v.content)}</div></div><div class="actions"><button type="button" id="backToVersions">Voltar</button></div>`;$('#backToVersions').onclick=()=>openTemplateVersions(slug);return}
      if(b.dataset.action==='default'){try{await api(`/api/developer/contract-templates/${v.id}/default`,{method:'POST'});toast('Versão marcada como padrão.');$('#modal').close();contracts()}catch(err){toast(err.message)}}
    };
  }

  function placeholderPanelHtml(){
    const groups={};
    Object.entries(state.contractMeta.placeholders).forEach(([key,label])=>{const prefix=key.split('_')[0];(groups[prefix]=groups[prefix]||[]).push([key,label])});
    const groupLabels={CONTRATADA:'Contratada (PapiCore)',CLIENTE:'Cliente',PLANO:'Plano',CONTRATO:'Contrato'};
    return Object.entries(groups).map(([g,items])=>`<h4>${esc(groupLabels[g]||g)}</h4>${items.map(([key,label])=>`<div class="placeholder-item"><code title="${esc(label)}">{{${key}}}</code><button type="button" data-insert="${key}">Inserir</button></div>`).join('')}`).join('');
  }

  function openTemplateEditor(tpl){
    const editing=Boolean(tpl);
    $('#modalBody').innerHTML=`<h2>${editing?'Editar modelo (cria nova versão)':'Novo modelo'}</h2>${DISCLAIMER_HTML}
      <form id="templateForm">
        <div class="grid-form">
          <label>Nome *<input name="name" value="${editing?esc(tpl.name):''}" required></label>
          <label>Tipo de contrato<select name="contract_type">${state.contractMeta.contract_types.map(t=>`<option value="${t}" ${editing&&tpl.contract_type===t?'selected':''}>${esc(contractTypeLabel(t))}</option>`).join('')}</select></label>
          <label class="wide">Descrição<input name="description" value="${editing?esc(tpl.description||''):''}"></label>
        </div>
        <div class="contract-editor">
          <label>Conteúdo do modelo *<textarea name="content" id="templateContent" required>${editing?esc(tpl.content):''}</textarea></label>
          <div class="placeholder-panel"><h4>Campos disponíveis</h4><p class="muted" style="font-size:12px;margin-top:0">Clique para inserir no cursor.</p>${placeholderPanelHtml()}</div>
        </div>
        <div class="actions wide"><button type="button" data-close>Cancelar</button><button class="primary" type="submit">${editing?'Salvar nova versão':'Criar modelo'}</button></div>
      </form>`;
    openModal();
    $('#modalBody').querySelector('[data-close]').onclick=()=>$('#modal').close();
    $('#modalBody').querySelectorAll('[data-insert]').forEach(btn=>{btn.onclick=()=>{const ta=$('#templateContent');const token=`{{${btn.dataset.insert}}}`;const start=ta.selectionStart||0,end=ta.selectionEnd||0;ta.value=ta.value.slice(0,start)+token+ta.value.slice(end);ta.focus();ta.selectionStart=ta.selectionEnd=start+token.length}});
    $('#templateForm').onsubmit=async e=>{
      e.preventDefault();const btn=e.submitter;btn.disabled=true;
      try{
        const raw=Object.fromEntries(new FormData(e.target));
        if(!raw.name||raw.name.trim().length<2)throw new Error('Informe o nome do modelo.');
        if(editing)await api(`/api/developer/contract-templates/${tpl.id}`,{method:'PUT',body:JSON.stringify(raw)});
        else await api('/api/developer/contract-templates',{method:'POST',body:JSON.stringify(raw)});
        $('#modal').close();toast(editing?'Nova versão do modelo criada.':'Modelo criado.');contracts()
      }catch(err){toast(err.message)}finally{btn.disabled=false}
    };
  }

  /* --- Novo contrato --- */
  async function renderNewContract(bodyEl){
    const tenantsSorted=[...state.tenants].sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt'));
    const currentTemplates=await api('/api/developer/contract-templates/current');
    state.currentTemplates=currentTemplates;
    bodyEl.innerHTML=`${DISCLAIMER_HTML}<div class="panel"><h2>Novo contrato</h2>
      ${currentTemplates.length?'':'<p class="error">Nenhum modelo de contrato cadastrado. Cadastre um modelo na aba "Modelos" antes de continuar.</p>'}
      <form id="newContractForm" class="grid-form">
        <label class="wide">Buscar empresa<input id="tenantSearch" placeholder="Nome, slug, documento ou domínio"></label>
        <label class="wide">Empresa *<select name="tenant_id" id="tenantSelect" required>${tenantsSorted.map(t=>`<option value="${t.id}" data-search="${esc((t.name+' '+t.slug+' '+(t.document||'')+' '+(t.domains&&t.domains[0]?t.domains[0].domain:'')).toLowerCase())}">${esc(t.name)} — ${esc(t.slug)}</option>`).join('')}</select></label>
        <div id="tenantInfoBox" class="wide"></div>
        <label>Modelo<select name="template_id" id="templateSelect">${currentTemplates.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        <label>Tipo de contrato<select name="contract_type">${state.contractMeta.contract_types.map(t=>`<option value="${t}">${esc(contractTypeLabel(t))}</option>`).join('')}</select></label>
        <label>Plano<select name="plan_id" id="planSelect"><option value="">Usar plano atual da empresa</option>${state.plans.map(p=>`<option value="${p.id}">${esc(p.name)} (${formatCents(p.monthly_price_cents)}/mês)</option>`).join('')}</select></label>
        <label>Periodicidade<select name="billing_periodicity" id="periodicitySelect">${state.contractMeta.billing_periodicities.map(p=>`<option value="${p}">${esc(state.contractMeta.periodicity_labels[p])}</option>`).join('')}</select></label>
        <label>Data de início *<input type="date" name="start_date" required></label>
        <label>Duração (meses)<input type="number" name="duration_months" min="1" value="12"></label>
        <label>Desconto (R$)<input name="discount_cents" placeholder="0,00"></label>
        <label>Implantação (R$)<input name="implementation_fee_cents" placeholder="0,00"></label>
        <label id="customSubtotalLabel" class="hidden">Valor personalizado (R$)<input name="subtotal_cents" placeholder="Obrigatório para periodicidade personalizada"></label>
        <label>Forma de pagamento<input name="payment_method" placeholder="Pix, boleto, cartão…"></label>
        <label>Dia de vencimento<input name="billing_day" type="number" min="1" max="31"></label>
        <label>Foro<input name="jurisdiction" placeholder="Vazio = foro padrão da contratada"></label>
        <label class="wide">Observações<textarea name="notes" rows="2"></textarea></label>
        <div class="actions wide"><button type="button" class="primary" id="previewBtn">Gerar prévia</button></div>
      </form>
    </div>
    <div id="previewBox"></div>`;

    function renderTenantInfo(){
      const id=$('#tenantSelect').value;
      const t=state.tenants.find(x=>String(x.id)===id);
      const box=$('#tenantInfoBox');
      if(!t){box.innerHTML='';return}
      const domain=(t.domains||[]).find(d=>d.is_primary)||(t.domains||[])[0];
      box.innerHTML=`<div class="tenant-info-card"><b>${esc(t.name)}</b>Documento: ${esc(t.document||'—')} · E-mail: ${esc(t.email||'—')} · Telefone: ${esc(t.phone||'—')} · Domínio: ${esc(domain?domain.domain:'—')} · Plano atual: ${esc(t.plan||'—')} · Administrador: ${esc(t.admin?t.admin.name:'—')}${!t.document?'<div class="contract-missing" style="margin-top:8px"><b>Esta empresa não possui documento cadastrado.</b> <button type="button" id="editTenantFromContract">Editar empresa</button></div>':''}</div>`;
      if(!t.document){const editBtn=$('#editTenantFromContract');if(editBtn)editBtn.onclick=()=>openTenantForm(t)}
    }
    renderTenantInfo();
    $('#tenantSelect').onchange=renderTenantInfo;
    $('#tenantSearch').oninput=()=>{const q=$('#tenantSearch').value.toLowerCase();[...$('#tenantSelect').options].forEach(opt=>{opt.hidden=Boolean(q)&&!opt.dataset.search.includes(q)})};
    $('#periodicitySelect').onchange=()=>{$('#customSubtotalLabel').classList.toggle('hidden',$('#periodicitySelect').value!=='CUSTOM')};

    $('#previewBtn').onclick=async()=>{
      const raw=Object.fromEntries(new FormData($('#newContractForm')));
      if(!raw.tenant_id)return toast('Selecione uma empresa.');
      if(!raw.start_date)return toast('Informe a data de início.');
      const payload=buildContractPayload(raw);
      try{
        const result=await api('/api/developer/contracts/preview',{method:'POST',body:JSON.stringify(payload)});
        state.lastContractPayload=payload;
        renderContractPreview(result);
      }catch(err){toast(err.message)}
    };
  }

  function buildContractPayload(raw){
    return {
      tenant_id:Number(raw.tenant_id),
      template_id:raw.template_id?Number(raw.template_id):undefined,
      contract_type:raw.contract_type,
      plan_id:raw.plan_id?Number(raw.plan_id):undefined,
      billing_periodicity:raw.billing_periodicity,
      start_date:raw.start_date,
      duration_months:raw.duration_months?Number(raw.duration_months):undefined,
      discount_cents:raw.discount_cents?parseBRLToCents(raw.discount_cents):0,
      implementation_fee_cents:raw.implementation_fee_cents?parseBRLToCents(raw.implementation_fee_cents):0,
      subtotal_cents:raw.billing_periodicity==='CUSTOM'&&raw.subtotal_cents?parseBRLToCents(raw.subtotal_cents):undefined,
      payment_method:raw.payment_method||undefined,
      billing_day:raw.billing_day?Number(raw.billing_day):undefined,
      jurisdiction:raw.jurisdiction||undefined,
      notes:raw.notes||undefined
    };
  }

  function renderContractPreview(result){
    const box=$('#previewBox');
    const missing=result.missing_required||[];
    const labels=missing.map(k=>state.contractMeta.placeholders[k]||k);
    box.innerHTML=`<div class="panel">
      <h2>Prévia do contrato</h2>
      ${missing.length?`<div class="contract-missing"><b>Campos obrigatórios pendentes:</b> ${labels.map(esc).join(', ')}. A finalização ficará bloqueada até estes dados existirem.</div>`:''}
      <div class="contract-summary">
        <div><span>Subtotal</span><b>${formatCents(result.financials.subtotal_cents)}</b></div>
        <div><span>Desconto</span><b>${formatCents(result.financials.discount_cents)}</b></div>
        <div><span>Implantação</span><b>${formatCents(result.financials.implementation_fee_cents)}</b></div>
        <div><span>Total</span><b>${formatCents(result.financials.total_cents)}</b></div>
      </div>
      <div class="contract-page-wrap"><div class="contract-page">${esc(result.content)}</div></div>
      <div class="actions wide"><button type="button" class="primary" id="saveDraftBtn">Salvar rascunho</button></div>
    </div>`;
    $('#saveDraftBtn').onclick=async()=>{
      const btn=$('#saveDraftBtn');btn.disabled=true;
      try{
        const created=await api('/api/developer/contracts',{method:'POST',body:JSON.stringify(state.lastContractPayload)});
        toast(`Contrato ${created.contract_number} criado como rascunho.`);
        openContractModal(created);
      }catch(err){toast(err.message)}finally{btn.disabled=false}
    };
  }

  /* --- Contratos gerados (histórico) --- */
  async function renderContractHistory(bodyEl){
    const list=await api('/api/developer/contracts');
    state.contractsList=list;
    bodyEl.innerHTML=`<div class="toolbar">
      <input id="cSearch" placeholder="Buscar por número">
      <select id="cTenant"><option value="">Todas as empresas</option>${[...state.tenants].sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt')).map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <select id="cStatus"><option value="">Todos os status</option>${state.contractMeta.statuses.map(s=>`<option value="${s}">${esc(contractStatusLabel(s))}</option>`).join('')}</select>
      <select id="cType"><option value="">Todos os tipos</option>${state.contractMeta.contract_types.map(t=>`<option value="${t}">${esc(contractTypeLabel(t))}</option>`).join('')}</select>
    </div><div id="contractsTable"></div>`;
    const draw=()=>{
      const q=($('#cSearch').value||'').toLowerCase(),tf=$('#cTenant').value,sf=$('#cStatus').value,tyf=$('#cType').value;
      const rows=list.filter(c=>(!q||c.contract_number.toLowerCase().includes(q))&&(!tf||String(c.tenant_id)===tf)&&(!sf||c.status===sf)&&(!tyf||c.contract_type===tyf))
        .map(c=>`<tr class="row-click" data-id="${c.id}"><td>${esc(c.contract_number)}</td><td>${esc(c.tenant?c.tenant.name:'—')}</td><td>${esc(contractTypeLabel(c.contract_type))}</td><td>${esc(c.plan_name||'—')}</td><td>${formatCents(c.total_cents)}</td><td>${date(c.start_date)}</td><td>${date(c.end_date)}</td><td>${contractStatusBadge(c.status)}</td><td>${esc(c.created_at)}</td><td><div class="row-actions">${c.pdf_path?iconBtn('backup','neutral','download',c.id,'Baixar PDF'):''}${iconBtn('detail','edit','open',c.id,'Abrir')}</div></td></tr>`);
      $('#contractsTable').innerHTML=table(['Número','Empresa','Tipo','Plano','Valor','Início','Vencimento','Status','Criado em','Ações'],rows);
    };
    draw();
    $('#cSearch').oninput=draw;$('#cTenant').onchange=draw;$('#cStatus').onchange=draw;$('#cType').onchange=draw;
    $('#contractsTable').onclick=e=>{
      const dlBtn=e.target.closest('[data-action="download"]');
      if(dlBtn){const c0=list.find(x=>String(x.id)===dlBtn.dataset.id);return fetchContractDownload(`/api/developer/contracts/${dlBtn.dataset.id}/download`,c0?`${c0.contract_number}.pdf`:undefined)}
      const openBtn=e.target.closest('[data-action="open"]');
      const row=e.target.closest('tr[data-id]');
      const id=(openBtn||row)?.dataset.id;
      if(!id)return;
      const c=list.find(x=>String(x.id)===id);
      if(c)openContractModal(c);
    };
  }

  /* Download do PDF do contrato — variante de fetchDownload() com mensagens
     próprias (fetchDownload é compartilhada com a aba Backups e sempre
     exibe "Backup baixado."). */
  async function fetchContractDownload(url,fallbackName){
    try{
      const headers={};if(state.token)headers.Authorization='Bearer '+state.token;
      const r=await fetch(url,{headers});
      if(!r.ok){if(r.status===404)throw new Error('Arquivo não encontrado.');const d=await r.json().catch(()=>null);throw new Error(d?.error||'Falha ao baixar o PDF do contrato.')}
      const blob=await r.blob();
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);
      const cd=r.headers.get('Content-Disposition')||'';const m=cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      a.download=m?m[1]:(fallbackName||'contrato.pdf');
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),4000);
      toast('PDF do contrato baixado.');
    }catch(err){toast(err.message)}
  }

  /* --- Modal compartilhado (rascunho/finalizado, usado por Novo contrato e Histórico) --- */
  function contractSummaryHtml(c){
    return `<div class="contract-summary">
      <div><span>Subtotal</span><b>${formatCents(c.subtotal_cents)}</b></div>
      <div><span>Desconto</span><b>${formatCents(c.discount_cents)}</b></div>
      <div><span>Implantação</span><b>${formatCents(c.implementation_fee_cents)}</b></div>
      <div><span>Total</span><b>${formatCents(c.total_cents)}</b></div>
      <div><span>Início</span><b>${date(c.start_date)}</b></div>
      <div><span>Vencimento</span><b>${date(c.end_date)}</b></div>
    </div>`;
  }

  function contractActionButtons(c){
    const btns=[];
    if(c.status==='DRAFT')btns.push('<button type="button" data-caction="finalize" class="primary">Finalizar e gerar PDF</button>');
    if(c.pdf_path)btns.push('<button type="button" data-caction="download">Baixar PDF</button>');
    if(c.status==='FINALIZED'){btns.push('<button type="button" data-caction="renewal">Gerar renovação</button>');btns.push('<button type="button" data-caction="addendum">Gerar aditivo</button>');btns.push('<button type="button" data-caction="cancel" class="danger">Cancelar contrato</button>')}
    btns.push('<button type="button" data-caction="duplicate">Duplicar</button>');
    return btns.join('');
  }

  function openContractModal(contract){
    const editable=contract.status==='DRAFT';
    $('#modalBody').innerHTML=`<h2>${esc(contract.contract_number)} — ${esc(contract.tenant?contract.tenant.name:'')}</h2>
      <p class="muted">${esc(contractTypeLabel(contract.contract_type))} · ${contractStatusBadge(contract.status)}</p>
      ${contractSummaryHtml(contract)}
      <form id="contractEditForm">
        <div class="grid-form">
          <label>Forma de pagamento<input name="payment_method" value="${esc(contract.payment_method||'')}" ${editable?'':'disabled'}></label>
          <label>Dia de vencimento<input name="billing_day" type="number" min="1" max="31" value="${contract.billing_day||''}" ${editable?'':'disabled'}></label>
          <label class="wide">Observações<textarea name="notes" rows="2" ${editable?'':'disabled'}>${esc(contract.notes||'')}</textarea></label>
        </div>
        <label>Texto do contrato<textarea name="content" id="contractContentArea" rows="16" ${editable?'':'readonly'}>${esc(contract.content)}</textarea></label>
        <div class="actions wide">${editable?'<button type="button" class="primary" id="saveContractDraft">Salvar alterações</button>':''}</div>
      </form>
      <div class="actions wide">${contractActionButtons(contract)}<button type="button" data-close>Fechar</button></div>`;
    openModal();
    $('#modalBody').querySelector('[data-close]').onclick=()=>{$('#modal').close();contracts()};
    if(editable){const saveBtn=$('#saveContractDraft');if(saveBtn)saveBtn.onclick=async()=>{try{const raw=Object.fromEntries(new FormData($('#contractEditForm')));await api(`/api/developer/contracts/${contract.id}`,{method:'PUT',body:JSON.stringify(raw)});toast('Rascunho atualizado.');const updated=await api(`/api/developer/contracts/${contract.id}`);openContractModal(updated)}catch(err){toast(err.message)}}}
    $('#modalBody').querySelectorAll('[data-caction]').forEach(btn=>{btn.onclick=()=>contractModalAction(btn.dataset.caction,contract)});
  }

  async function contractModalAction(action,contract){
    try{
      if(action==='finalize'){if(!confirm('Finalizar este contrato e gerar o PDF? Depois de finalizado o texto não pode mais ser editado diretamente.'))return;const updated=await api(`/api/developer/contracts/${contract.id}/finalize`,{method:'POST'});toast('Contrato gerado com sucesso.');openContractModal(updated);return}
      if(action==='download')return fetchContractDownload(`/api/developer/contracts/${contract.id}/download`,`${contract.contract_number}.pdf`);
      if(action==='duplicate'){const dup=await api(`/api/developer/contracts/${contract.id}/duplicate`,{method:'POST'});toast(`Contrato ${dup.contract_number} criado como cópia.`);openContractModal(dup);return}
      if(action==='renewal'){const ren=await api(`/api/developer/contracts/${contract.id}/renewal`,{method:'POST',body:JSON.stringify({})});toast(`Renovação ${ren.contract_number} criada.`);openContractModal(ren);return}
      if(action==='addendum'){const changes=prompt('Descreva as cláusulas alteradas por este aditivo:');if(!changes)return;const add=await api(`/api/developer/contracts/${contract.id}/addendum`,{method:'POST',body:JSON.stringify({changes})});toast(`Aditivo ${add.contract_number} criado.`);openContractModal(add);return}
      if(action==='cancel'){const reason=prompt('Motivo do cancelamento (opcional):')||'';if(!confirm('Cancelar este contrato?'))return;const cancelled=await api(`/api/developer/contracts/${contract.id}/cancel`,{method:'POST',body:JSON.stringify({reason})});toast('Contrato cancelado.');openContractModal(cancelled);return}
    }catch(err){toast(err.message)}
  }

  $('#loginForm').onsubmit=async e=>{e.preventDefault();const btn=e.submitter;btn.disabled=true;btn.textContent='Entrando…';$('#loginError').textContent='';try{const d=await api('/api/developer/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});state.token=d.token;sessionStorage.setItem(TOKEN_KEY,d.token);await boot()}catch(err){state.token='';sessionStorage.removeItem(TOKEN_KEY);$('#loginError').textContent=err.message}finally{btn.disabled=false;btn.textContent='Entrar'}};
  $('#showPassword').onclick=()=>{const p=$('#password');p.type=p.type==='password'?'text':'password';$('#showPassword').textContent=p.type==='password'?'Mostrar':'Ocultar'};$('#logout').onclick=logout;$('#refresh').onclick=render;$('#menu').onclick=()=>$('#sidebar').classList.toggle('open');  $('#modalClose').onclick=()=>{if(state.modalLocked)return;$('#modal').close()};$('#modal').addEventListener('cancel',e=>{if(state.modalLocked)e.preventDefault()});logout();
})();
