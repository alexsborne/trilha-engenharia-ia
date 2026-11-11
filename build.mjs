// Gera o site da trilha (docs/index.html), criptografado com senha.
// Conteúdo em ./conteudo/ (fora do git — o repositório é público e só recebe o HTML criptografado).
// Uso: TRILHA_PASSWORD=... node build.mjs
// Também grava ./resumo.json (sem textos), lido pelo painel Alfred.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { marked } from 'marked';

const password = process.env.TRILHA_PASSWORD;
if (!password) throw new Error('Defina TRILHA_PASSWORD');

const cfg = JSON.parse(readFileSync('conteudo/fases.json', 'utf8'));
marked.setOptions({ gfm: true, breaks: false });

// ---------- datas ----------
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const pausas = new Map(cfg.pausas.map(p => [p.inicio, p.motivo]));
let cursor = cfg.inicio;
const calendario = [];           // semanas na ordem, com pausas
function proximaSemana() {
  while (pausas.has(cursor)) {
    calendario.push({ pausa: true, inicio: cursor, fim: addDays(cursor, 6), motivo: pausas.get(cursor) });
    cursor = addDays(cursor, 7);
  }
  const s = { inicio: cursor, fim: addDays(cursor, 4) };
  cursor = addDays(cursor, 7);
  return s;
}

// ---------- markdown das fases detalhadas ----------
function parseSemanas(md) {
  const partes = md.split(/^# (S\d+) \| (.+)$/m).slice(1);
  const out = [];
  for (let i = 0; i < partes.length; i += 3) {
    const [id, titulo, corpo] = [partes[i], partes[i + 1].trim(), partes[i + 2]];
    const blocos = corpo.split(/^## (Sessão \d+ — .+)$/m);
    const intro = blocos[0];
    const sessoes = [];
    for (let j = 1; j < blocos.length; j += 2) sessoes.push({ titulo: blocos[j].trim(), md: blocos[j + 1] });
    out.push({ id, titulo, intro, sessoes });
  }
  return out;
}

const semanas = [];
const fases = [];
let n = 0;
for (const f of cfg.fases) {
  const fase = { id: f.id, nome: f.nome, grade: f.grade, projetos: f.projetos, semanas: [] };
  let lista;
  if (f.detalhada) {
    const arquivos = [].concat(f.detalhada);
    lista = arquivos.flatMap(a => parseSemanas(readFileSync('conteudo/' + a, 'utf8')));
  } else {
    // Semana de roteiro que já foi detalhada: conteudo/semanas/Sxx.md (mesmo formato das fases detalhadas)
    lista = f.semanas.map((w, k) => {
      const id = 'S' + String(n + k + 1).padStart(2, '0');
      const arq = `conteudo/semanas/${id}.md`;
      if (existsSync(arq)) return { ...parseSemanas(readFileSync(arq, 'utf8'))[0], projeto: w.projeto };
      return { ...w, roteiro: true };
    });
  }
  for (const w of lista) {
    n++;
    const id = 'S' + String(n).padStart(2, '0');
    if (w.id && w.id !== id) throw new Error(`Numeração fora de ordem: esperado ${id}, achei ${w.id}`);
    const datas = proximaSemana();
    const sem = { id, fase: f.id, ...datas, titulo: w.titulo, roteiro: !!w.roteiro, projeto: w.projeto || null };
    if (w.roteiro) {
      const rec = (w.recursos || []).map(([l, u]) => `- [${l}](${u})`).join('\n');
      sem.introHtml = marked.parse(
        `**Tópicos:** ${w.topicos}\n\n` + (rec ? `**Material de partida**\n\n${rec}\n\n` : '') +
        `> 📝 Roteiro. O texto completo de cada sessão (teoria, links e exercícios) é escrito quando você chegar perto desta semana — digite **VAMOS ESTUDAR IA** e peça "detalhar a ${id}".`);
      sem.sessoes = Array.from({ length: f.sessoesPorSemana }, (_, k) => ({ id: `${id}-${k + 1}`, titulo: `Sessão ${k + 1}`, html: '' }));
    } else {
      if (w.sessoes.length !== f.sessoesPorSemana) console.warn(`⚠ ${id} tem ${w.sessoes.length} sessões (fase pede ${f.sessoesPorSemana})`);
      sem.introHtml = marked.parse(w.intro);
      sem.sessoes = w.sessoes.map((s, k) => ({ id: `${id}-${k + 1}`, titulo: s.titulo, html: marked.parse(s.md) }));
    }
    semanas.push(sem);
    calendario.push({ id });
    fase.semanas.push(id);
  }
  fases.push(fase);
}

const dados = {
  titulo: cfg.titulo, geradoEm: iso(new Date()),
  fases, semanas, calendario,
  totalSessoes: semanas.reduce((s, w) => s + w.sessoes.length, 0),
};

// resumo sem textos, para o Alfred
writeFileSync('resumo.json', JSON.stringify({
  titulo: cfg.titulo, geradoEm: dados.geradoEm, totalSessoes: dados.totalSessoes,
  site: 'https://alexsborne.github.io/trilha-engenharia-ia/',
  fases: fases.map(f => ({ id: f.id, nome: f.nome, projetos: f.projetos, semanas: f.semanas })),
  calendario: calendario.map(c => c.pausa ? c : (({ id, fase, inicio, fim, titulo, projeto, roteiro, sessoes }) =>
    ({ id, fase, inicio, fim, titulo, projeto, roteiro, sessoes: sessoes.map(s => ({ id: s.id, titulo: s.titulo })) }))(semanas.find(s => s.id === c.id))),
}, null, 2));

// ---------- criptografia (mesmo esquema do Alfred) ----------
const iterations = 600000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes,
  new TextEncoder().encode(JSON.stringify(dados))));
const b64 = u => Buffer.from(u).toString('base64');
const payload = JSON.stringify({ iterations, salt: b64(salt), iv: b64(iv), data: b64(cifrado) });

mkdirSync('docs', { recursive: true });
writeFileSync('docs/index.html', readFileSync('template.html', 'utf8').replace('/*PAYLOAD*/null', payload));
writeFileSync('docs/.nojekyll', '');
const ult = semanas.at(-1);
console.log(`docs/index.html gerado — ${semanas.length} semanas, ${dados.totalSessoes} sessões, ${calendario.filter(c => c.pausa).length} pausas; termina em ${ult.fim} (${ult.id}).`);
