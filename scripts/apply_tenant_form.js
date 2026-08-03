const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'public', 'js', 'desenvolvedor.js');
const fragmentPath = path.join(__dirname, 'fragment_tenantForm.js');

const lines = fs.readFileSync(target, 'utf8').split('\n');
const fragment = fs.readFileSync(fragmentPath, 'utf8');

const openIdx = lines.findIndex((l) => l.includes('function openTenantForm(tenant)'));
if (openIdx === -1) throw new Error('openTenantForm não encontrado');
const usersIdx = lines.findIndex((l, i) => i > openIdx && l.includes('async function loadTenantUsers(tenant)'));
if (usersIdx === -1) throw new Error('loadTenantUsers não encontrado');

if (!lines[usersIdx].includes('renderOwnerSection')) {
  lines[usersIdx] = lines[usersIdx].replace(
    'const users=await api(`/api/developer/users?tenant_id=${tenant.id}`);',
    'const users=await api(`/api/developer/users?tenant_id=${tenant.id}`);renderOwnerSection(tenant,users.find(u=>u.role===\'owner\')||users[0]||null);'
  );
}

lines[openIdx] = fragment;

fs.writeFileSync(target, lines.join('\n'), 'utf8');
console.log('OK: openTenantForm (linha', openIdx + 1, ') e loadTenantUsers (linha', usersIdx + 1, ') atualizados.');
