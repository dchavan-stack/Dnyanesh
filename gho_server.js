const http        = require('http');
const https       = require('https');
const { execFile } = require('child_process');
const fs          = require('fs');
const path        = require('path');

const SLACK_TOKEN              = 'xoxp-265193767125-1413746502834-11223796552516-6eb06c247f7d1119281eb1545fd6e826';
const CHANNEL_ID               = 'C01QUSKCDD3';
const SIG_MCE_CHANNEL_ID       = 'C01J4997YKV';
const MARKETING_APP_CHANNEL_ID = 'C06K45MFZDW';
const TIL_CHANNEL_ID           = 'C02NQEWH16E';
const PORT               = 7788;

const CIC_CACHE_FILE = path.join(__dirname, 'cic_cache.json');

// ── OrgCS — calls Salesforce MCP endpoint using Claude Code's keychain token ──
// Claude Code stores the orgcs mcp_api token under "Claude Code-credentials".
// We read it via `security`, open a fresh MCP session, and call soqlQuery.
// The mcp_api token only works against the MCP endpoint — not direct REST.

const MCP_HOST = 'api.salesforce.com';
const MCP_PATH = '/platform/mcp/v1/platform/sobject-reads';

let _sfToken = null;

async function readTokenFromKeychain() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      (err, stdout) => {
        if (err) return reject(Object.assign(new Error('Keychain read failed — is Claude Code running?'), { code: 'NEED_AUTH' }));
        try {
          const blob = JSON.parse(stdout.trim());
          const entry = Object.values(blob.mcpOAuth || {}).find(e => e.serverName === 'orgcs');
          if (!entry?.accessToken) throw new Error('No orgcs token found in keychain');
          resolve(entry.accessToken);
        } catch (e) {
          reject(Object.assign(e, { code: 'NEED_AUTH' }));
        }
      }
    );
  });
}

async function getToken(forceRefresh = false) {
  if (!_sfToken || forceRefresh) _sfToken = await readTokenFromKeychain();
  return _sfToken;
}

// One MCP HTTP request: returns { status, headers, body }
function mcpPost(token, sessionId, payload) {
  const bodyStr = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(bodyStr)
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = https.request({ hostname: MCP_HOST, path: MCP_PATH, method: 'POST', headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          _sfToken = null;
          return reject(Object.assign(
            new Error('OrgCS token expired or unauthorized (HTTP ' + res.statusCode + ')'),
            { code: 'NEED_AUTH' }
          ));
        }
        try {
          // Response may be plain JSON or SSE (data: {...})
          const text = d.trim();
          const jsonStr = text.startsWith('data:') ? text.replace(/^data:\s*/m, '').trim() : text;
          resolve({ status: res.statusCode, sessionId: res.headers['mcp-session-id'], body: JSON.parse(jsonStr) });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function mcpSOQL(soql) {
  const token = await getToken();

  // Step 1: initialize — get a session ID
  const init = await mcpPost(token, null, {
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gho-server', version: '1.0' } }
  });
  const sid = init.sessionId;
  if (!sid) throw new Error('No session ID from MCP initialize');

  // Step 2: tools/call soqlQuery
  const result = await mcpPost(token, sid, {
    jsonrpc: '2.0', id: 'q1', method: 'tools/call',
    params: { name: 'soqlQuery', arguments: { q: soql } }
  });
  if (result.body?.error) throw new Error(result.body.error.message || JSON.stringify(result.body.error));

  // Parse the text content returned by the tool
  const content = result.body?.result?.content;
  if (!content) throw new Error('Empty MCP tool response');
  const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : String(content);
  return JSON.parse(text);
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normCICSev(raw) {
  if (!raw) return { label: '—', badge: 'badge-nmi' };
  if (/level\s*1|critical/i.test(raw)) return { label: 'L1 Critical', badge: 'badge-critical' };
  if (/level\s*2|urgent/i.test(raw))   return { label: 'L2 Urgent',   badge: 'badge-urgent'   };
  if (/level\s*3|high/i.test(raw))     return { label: 'L3 High',     badge: 'badge-nmi'      };
  return { label: raw, badge: 'badge-nmi' };
}

async function fetchCICCases() {
  // Primary: try live MCP query via keychain token
  try {
    const soql = [
      "SELECT Id, CaseNumber, Subject, Status, Severity_Level__c,",
      "Account.Name, Owner.Name,",
      "AX_CIC_Substatus__c, CIC_Engagement_Status__c,",
      "AX_CIC_Case_Commander__r.Name,",
      "AX_Engagement_Start_Time__c, AX_CIC_Duration__c,",
      "AX_Sev1_Start_Time__c, AX_Sev1_Duration__c,",
      "AX_CIC_Sev1_CAN__c, cssf_Product_Topic_Name__c",
      "FROM Case",
      "WHERE CIC_Engagement_Status__c = 'CIC Engaged'",
      "AND (cssf_Product_Topic_Name__c LIKE 'Engagement%'",
      "  OR cssf_Product_Topic_Name__c LIKE 'Personalization%'",
      "  OR cssf_Product_Topic_Name__c LIKE 'Social Studio%'",
      "  OR cssf_Product_Topic_Name__c LIKE 'Intelligence%'",
      "  OR cssf_Product_Topic_Name__c LIKE 'Account Engagement%'",
      "  OR cssf_Product_Topic_Name__c LIKE 'Marketing%')",
      "ORDER BY AX_Engagement_Start_Time__c DESC",
      "LIMIT 100"
    ].join(' ');

    const result = await mcpSOQL(soql);
    if (!Array.isArray(result.records)) throw new Error('bad response');

    const cases = result.records.map(c => {
      const sev = normCICSev(c.Severity_Level__c);
      return {
        id:              c.Id,
        caseNum:         c.CaseNumber,
        subject:         (c.Subject || '').slice(0, 120),
        status:          c.Status,
        severity:        sev.label,
        sevBadge:        sev.badge,
        account:         c.Account?.Name || '—',
        owner:           c.Owner?.Name   || '—',
        subStatus:       c.AX_CIC_Substatus__c || '—',
        commander:       c.AX_CIC_Case_Commander__r?.Name || '—',
        engagementStart: c.AX_Engagement_Start_Time__c || null,
        cicDuration:     c.AX_CIC_Duration__c  || '—',
        sev1Duration:    c.AX_Sev1_Duration__c || '—',
        can:             stripHtml(c.AX_CIC_Sev1_CAN__c || '').slice(0, 400),
        productTopic:    c.cssf_Product_Topic_Name__c || '—',
        caseUrl:         `https://orgcs.lightning.force.com/lightning/r/Case/${c.Id}/view`
      };
    });

    // Filter out closed/resolved cases in JS — NOT LIKE is unsupported by the MCP endpoint
    const mcCases = cases.filter(c => {
      const s = (c.status || '').toLowerCase();
      return !s.startsWith('closed') && s !== 'resolved';
    });
    const cachePayload = { fetchedAt: new Date().toISOString(), cases: mcCases };
    fs.writeFileSync(CIC_CACHE_FILE, JSON.stringify(cachePayload, null, 2));
    return mcCases;

  } catch (liveErr) {
    console.log('Live MCP fetch failed, trying cache:', liveErr.message);
  }

  // Fallback: read from cache file written by Claude Code session
  if (fs.existsSync(CIC_CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CIC_CACHE_FILE, 'utf8'));
    console.log('Serving CIC from cache (fetched', cache.fetchedAt, ')');
    const MC_PREFIXES = ['engagement','personalization','social studio','intelligence','account engagement','marketing'];
    return (cache.cases || []).filter(c =>
      MC_PREFIXES.some(p => (c.productTopic || '').toLowerCase().startsWith(p))
    );
  }

  throw Object.assign(new Error('OrgCS not reachable and no cache available'), { code: 'NEED_AUTH' });
}

// ── Team Backlog ──────────────────────────────────────────────────────────────

function staleSuggestion(c) {
  const d = c.daysStale;
  const s = (c.status || '').toLowerCase();
  if (d > 14) return `Stale ${d}d — review for closure or escalation`;
  if (c.sevBadge === 'badge-critical' && d > 2) return `L1 Critical open ${d}d — urgent action needed`;
  if (c.sevBadge === 'badge-urgent'   && d > 3) return `L2 Urgent — check status and push to resolution`;
  if (s.includes('waiting')           && d > 5) return `Follow up with customer or close as no-response`;
  if (s === 'new'                     && d > 3) return `Needs triage — no activity since creation`;
  if (s === 'in progress'             && d > 7) return `In Progress for ${d}d — check for blockers`;
  return `Active — last updated ${d}d ago`;
}

async function fetchBacklogCases() {
  const soql = [
    "SELECT Id, CaseNumber, Subject, Status, Severity_Level__c,",
    "Account.Name, Owner.Name, CreatedDate, LastModifiedDate,",
    "cssf_Product_Topic_Name__c",
    "FROM Case",
    "WHERE (cssf_Product_Topic_Name__c LIKE 'Engagement%'",
    "  OR cssf_Product_Topic_Name__c LIKE 'Personalization%'",
    "  OR cssf_Product_Topic_Name__c LIKE 'Social Studio%'",
    "  OR cssf_Product_Topic_Name__c LIKE 'Intelligence%'",
    "  OR cssf_Product_Topic_Name__c LIKE 'Account Engagement%'",
    "  OR cssf_Product_Topic_Name__c LIKE 'Marketing%')",
    "ORDER BY Owner.Name, LastModifiedDate ASC",
    "LIMIT 500"
  ].join(' ');

  const result = await mcpSOQL(soql);
  if (!Array.isArray(result.records)) throw new Error('bad backlog response');

  const now = Date.now();
  const cases = result.records
    .filter(c => {
      const s = (c.Status || '').toLowerCase();
      return !s.startsWith('closed') && s !== 'resolved';
    })
    .map(c => {
      const sev = normCICSev(c.Severity_Level__c);
      const lastMod = c.LastModifiedDate ? new Date(c.LastModifiedDate).getTime() : now;
      const daysStale = Math.floor((now - lastMod) / 86400000);
      const shaped = {
        id:               c.Id,
        caseNum:          c.CaseNumber,
        subject:          (c.Subject || '').slice(0, 120),
        status:           c.Status || '—',
        severity:         sev.label,
        sevBadge:         sev.badge,
        account:          c.Account?.Name || '—',
        owner:            c.Owner?.Name   || '—',
        productTopic:     c.cssf_Product_Topic_Name__c || '—',
        createdDate:      c.CreatedDate || null,
        lastModifiedDate: c.LastModifiedDate || null,
        daysStale,
        caseUrl:          `https://orgcs.lightning.force.com/lightning/r/Case/${c.Id}/view`,
      };
      shaped.suggestion = staleSuggestion(shaped);
      return shaped;
    });

  const byOwner = {};
  cases.forEach(c => {
    if (!byOwner[c.owner]) byOwner[c.owner] = [];
    byOwner[c.owner].push(c);
  });
  // Sort each owner's cases: most stale first
  Object.values(byOwner).forEach(arr => arr.sort((a, b) => b.daysStale - a.daysStale));

  return { cases, byOwner };
}

// ── Slack API helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function slackGet(urlPath, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'slack.com',
        path: '/api/' + urlPath,
        headers: { Authorization: 'Bearer ' + SLACK_TOKEN }
      }, res => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '10', 10);
          res.resume();
          resolve({ _rateLimited: true, retryAfter });
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    if (result._rateLimited || (result.ok === false && result.error === 'ratelimited')) {
      const wait = (result.retryAfter || 10) * 1000;
      console.log(`Rate limited — waiting ${wait/1000}s (attempt ${attempt+1}/${retries+1})`);
      await sleep(wait);
      continue;
    }
    return result;
  }
  throw new Error('Slack rate limit persisted after retries');
}

async function fetchChannelMessages(oldest, latest, channelId) {
  const ch = channelId || CHANNEL_ID;
  let messages = [];
  let cursor;
  do {
    let url = `conversations.history?channel=${ch}&oldest=${oldest}&latest=${latest}&limit=200`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await slackGet(url);
    if (!res.ok) throw new Error('Slack error: ' + res.error);
    messages = messages.concat(res.messages || []);
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return messages;
}

async function fetchThread(ts, channelId) {
  const ch = channelId || CHANNEL_ID;
  const res = await slackGet(`conversations.replies?channel=${ch}&ts=${ts}&limit=100`);
  return res.ok ? (res.messages || []) : [];
}


// ── Parse a GHO message ──────────────────────────────────────────────────────

function parseGHO(msg) {
  const text = msg.text || '';
  if (!text.includes('NEW GHO REQUEST')) return null;

  const get = (label) => {
    const re = new RegExp(label + '[*_:\\s]*([^\\n*_]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim().replace(/[*_]/g, '') : '—';
  };

  return {
    ts:          msg.ts,
    timeLabel:   formatTs(msg.ts),
    caseNum:     get('Global Case Number'),
    account:     get('Account Name').replace(/\*$/, '').trim(),
    product:     get('Product & Topic').replace('Engagement-', ''),
    severity:    get('Severity'),
    plan:        get('Success Plan'),
    from:        get('Region Case Is Coming From'),
    to:          get('Region Case Is Going To'),
    status:      get('Current Status'),
    issue:       (get('Summary & Next Steps') !== '—' ? get('Summary & Next Steps') :
                  get('Problem Statement[^:]*') !== '—' ? get('Problem Statement[^:]*') :
                  get('Summary')).slice(0, 120),
    submittedBy: extractName(text, 'Submitted By'),
    manager:     extractName(text, 'Manager'),
    approvedBy:  extractApproverFromMsg(msg),
    threadTs:    msg.ts,
    replyCount:  msg.reply_count || 0,
    ghoOutcome:  'Pending', // overridden below after approvedBy is resolved
    reviewedBy:  '—',
    assignedTo:  '—',
    decisionTime:'—',
    decisionTs:  null,
    feedback:    null,
  };
}

function extractName(text, label) {
  // [*_:\s•]* allows formatting chars, whitespace, newlines, and the bullet (•) used in Sig MCE
  const re = new RegExp(label + '[*_:\\s•]*<@[^|]+\\|([^>]+)>', 'i');
  const m = text.match(re);
  return m ? m[1] : '—';
}

function extractApprover(text) {
  // With display name (text field): <@ID|name> clicked *APPROVE GHO* or *OWNER [GHO Request]*
  const m = text.match(/<@[^|>]+\|([^>]+)>\s+clicked\s+\*(?:APPROVE GHO|OWNER \[GHO Request\])\*/i);
  if (m) return m[1];
  // Without display name (blocks field): <@ID> clicked *OWNER [GHO Request]*
  const m2 = text.match(/<@([^|>]+)>\s+clicked\s+\*OWNER \[GHO Request\]\*/i);
  if (m2) return m2[1];
  return '—';
}

// Sig MCE: when someone clicks "OWNER [GHO Request]", Slack updates the parent
// message's blocks with a new section containing the click text — not a reply.
function extractApproverFromMsg(msg) {
  const fromText = extractApprover(msg.text || '');
  if (fromText !== '—') return fromText;
  const blocksText = (msg.blocks || [])
    .filter(b => b.type === 'section' && b.text && b.text.text)
    .map(b => b.text.text)
    .join('\n');
  return extractApprover(blocksText);
}

function formatTs(ts) {
  const d = new Date(parseFloat(ts) * 1000);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) + ', ' +
         d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
}

// ── Enrich with thread outcome ───────────────────────────────────────────────

function makeEnricher(channelId) {
  return async function enrichWithThread(gho) {
    return enrichWithThreadFor(gho, channelId);
  };
}

async function enrichWithThread(gho) {
  return enrichWithThreadFor(gho, CHANNEL_ID);
}

async function enrichWithThreadFor(gho, channelId) {
  if (gho.replyCount === 0) return gho;
  const isSigMce = channelId === SIG_MCE_CHANNEL_ID;
  try {
    const replies = await fetchThread(gho.threadTs, channelId);
    for (const r of replies) {
      const t = r.text || '';
      // Sig MCE: only "OWNER [GHO Request]" button click counts as assigned.
      // Standard GHO: use conventional assignment phrases.
      const isOwnerClick    = /clicked\s+\*OWNER \[GHO Request\]\*/i.test(t);
      const isStandardAccept = !isSigMce && (
        t.includes('has assigned the case') || t.includes('clicked *Assigned*') || t.includes('case is now with')
      );
      if (isOwnerClick || isStandardAccept) {
        gho.ghoOutcome   = 'Accepted';
        gho.reviewedBy   = extractName(t, '') || extractReviewer(t);
        gho.decisionTs   = parseFloat(r.ts) * 1000;
        gho.decisionTime = formatTs(r.ts);
        // For Sig MCE, approvedBy comes from the thread reply (OWNER click), not the original message
        if (isOwnerClick && gho.approvedBy === '—') {
          gho.approvedBy = gho.reviewedBy;
        }
      }
      if (t.includes('should not be reassigned') || t.includes('clicked *Not Assigned*') || t.includes('clicked *DECLINE [GHO Request]*')) {
        gho.ghoOutcome   = 'Rejected';
        gho.decisionTs   = parseFloat(r.ts) * 1000;
        gho.decisionTime = formatTs(r.ts);
      }
      if (t.includes('Feedback for') || (t.includes('Preventative') && gho.ghoOutcome === 'Rejected')) {
        gho.feedback = t.replace(/<[^>]+>/g,'').replace(/\*/g,'').trim().slice(0, 300);
      }
      const asgn = t.match(/(?:case is now with|case is with|with|Assigned to)\s*<@[^|]+\|([^>]+)>/i);
      if (asgn) gho.assignedTo = asgn[1];
      const rev = t.match(/<@[^|]+\|([^>]+)>is reviewing|<@[^|]+\|([^>]+)>\s+is now reviewing/i);
      if (rev) gho.reviewedBy = rev[1] || rev[2];
    }
  } catch (e) {
    // thread fetch failed — leave as Pending
  }
  return gho;
}

function extractReviewer(text) {
  const m = text.match(/<@[^|]+\|([^>]+)>/);
  return m ? m[1] : '—';
}

// ── Severity / Plan normalisers ──────────────────────────────────────────────

function normSeverity(raw) {
  if (!raw || raw === '—') return { label: '—', badge: 'badge-nmi' };
  if (/level\s*1|critical/i.test(raw)) return { label: 'L1 Critical', badge: 'badge-critical' };
  if (/level\s*2|urgent/i.test(raw))   return { label: 'L2 Urgent',   badge: 'badge-urgent'   };
  if (/level\s*3|high/i.test(raw))     return { label: 'L3 High',     badge: 'badge-nmi'      };
  if (/level\s*4|medium/i.test(raw))   return { label: 'L4 Medium',   badge: 'badge-nmi'      };
  return { label: raw, badge: 'badge-nmi' };
}

function normPlan(raw) {
  if (/premier/i.test(raw))  return 'Premier+';
  if (/standard/i.test(raw)) return 'Standard';
  return raw || '—';
}

// ── Main request handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // ── Static HTML dashboards ───────────────────────────────────────────────────
  const HTML_FILES = {
    '/':            'MC_gho_all_dashboard.html',
    '/all':         'MC_gho_all_dashboard.html',
    '/ist':         'gho_ist_dashboard.html',
    '/marketing':   'marketing_app_dashboard.html',
    '/shruthi':     'shruthi_dashboard.html',
    '/ist-backlog':  'ist_backlog_dashboard.html',
  };
  if (HTML_FILES[url.pathname] && req.method === 'GET') {
    const filePath = path.join(__dirname, HTML_FILES[url.pathname]);
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('Dashboard file not found');
    }
    return;
  }

  // ── /post-to-slack — post GHO+CIC summary to #support-pdt-today-i-learned ──
  if (url.pathname === '/post-to-slack' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { ghos = [], sigMce = [], mktApp = [], cic, from, to } = JSON.parse(body);

        const fmt = iso => new Date(iso).toLocaleString('en-IN', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
        }) + ' IST';

        const allGhos = [...ghos, ...sigMce, ...mktApp];

        const totals = arr => ({
          total:    arr.length,
          accepted: arr.filter(g => g.ghoOutcome === 'Accepted').length,
          rejected: arr.filter(g => g.ghoOutcome === 'Rejected').length,
          pending:  arr.filter(g => g.ghoOutcome === 'Pending').length,
        });

        const combined = totals(allGhos);
        const mainT    = totals(ghos);
        const sigT     = totals(sigMce);
        const mktT     = totals(mktApp);

        // ── GEO flow matrix from all GHOs ──
        const pairMap = {};
        allGhos.forEach(g => {
          if (!g.from || !g.to) return;
          pairMap[g.from] = pairMap[g.from] || {};
          pairMap[g.from][g.to] = (pairMap[g.from][g.to] || 0) + 1;
        });
        const fromGeos = Object.keys(pairMap).sort((a, b) =>
          Object.values(pairMap[b] || {}).reduce((s, v) => s + v, 0) -
          Object.values(pairMap[a] || {}).reduce((s, v) => s + v, 0)
        );
        const toGeoSet = new Set();
        allGhos.forEach(g => g.to && toGeoSet.add(g.to));
        const toGeos = [...toGeoSet].sort((a, b) => {
          const sumA = fromGeos.reduce((s, f) => s + (pairMap[f]?.[a] || 0), 0);
          const sumB = fromGeos.reduce((s, f) => s + (pairMap[f]?.[b] || 0), 0);
          return sumB - sumA;
        });

        const geoLines = fromGeos.map(f => {
          const cells = toGeos.map(t => {
            const n = pairMap[f]?.[t] || 0;
            return n ? `${t}: *${n}*` : null;
          }).filter(Boolean);
          return cells.length ? `• *${f}* → ${cells.join('  |  ')}` : null;
        }).filter(Boolean);

        // Build blocks
        const blocks = [
          { type: 'header', text: { type: 'plain_text', text: '📊 GHO Dashboard Summary', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: `*Period:* ${fmt(from)}  →  ${fmt(to)}` } },
          { type: 'divider' },

          // Combined summary
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Combined — All Channels*' },
            fields: [
              { type: 'mrkdwn', text: `*Total*\n${combined.total}` },
              { type: 'mrkdwn', text: `*Accepted ✅*\n${combined.accepted}` },
              { type: 'mrkdwn', text: `*Rejected ❌*\n${combined.rejected}` },
              { type: 'mrkdwn', text: `*Pending ⏳*\n${combined.pending}` },
            ]
          },
          { type: 'divider' },

          // Per-channel breakdown
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Per-Channel Breakdown*' },
            fields: [
              { type: 'mrkdwn', text: `*#support-mc-case-alert*\nTotal: ${mainT.total}  ✅ ${mainT.accepted}  ❌ ${mainT.rejected}  ⏳ ${mainT.pending}` },
              { type: 'mrkdwn', text: `*#support-sig-mce*\nTotal: ${sigT.total}  ✅ ${sigT.accepted}  ❌ ${sigT.rejected}  ⏳ ${sigT.pending}` },
              { type: 'mrkdwn', text: `*#support-marketing-app-case-alert*\nTotal: ${mktT.total}  ✅ ${mktT.accepted}  ❌ ${mktT.rejected}  ⏳ ${mktT.pending}` },
            ]
          },
        ];

        // GEO flow
        if (geoLines.length) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🗺️ GHO Flow by GEO*\n${geoLines.join('\n')}` } });
        }

        // Pending GHOs — all channels
        const pendingAll = allGhos.filter(g => g.ghoOutcome === 'Pending');
        if (pendingAll.length) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*⏳ Pending GHOs (${pendingAll.length})*` } });
          const chLabel = ch => ch === 'sig-mce' ? 'Sig-MCE' : ch === 'mkt-app' ? 'Mkt-App' : 'Main';
          pendingAll.slice(0, 15).forEach(g => {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `• *${g.caseNum}* | ${g.product} | ${g.severity} | ${g.from} → ${g.to} | _${g.submittedBy}_ | [${chLabel(g.channel)}]` }
            });
          });
          if (pendingAll.length > 15) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${pendingAll.length - 15} more_` } });
          }
        }

        // CIC cases
        if (cic && cic.length) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🔴 Active MC CIC Engagements (${cic.length})*` } });
          cic.slice(0, 10).forEach(c => {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `• *<${c.caseUrl}|${c.caseNum}>* | ${c.account} | ${c.productTopic} | CIC: ${c.cicDuration} | Commander: ${c.commander}` }
            });
          });
          if (cic.length > 10) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${cic.length - 10} more_` } });
          }
        } else {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🟢 Active MC CIC Engagements:* None at this time` } });
        }

        blocks.push({ type: 'divider' });
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Posted from GHO Dashboard · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })} IST` }] });

        const payload = JSON.stringify({ channel: TIL_CHANNEL_ID, blocks });
        const result  = await new Promise((resolve, reject) => {
          const postReq = https.request({
            hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + SLACK_TOKEN,
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload)
            }
          }, postRes => {
            let d = '';
            postRes.on('data', c => d += c);
            postRes.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          });
          postReq.on('error', reject);
          postReq.write(payload);
          postReq.end();
        });

        if (!result.ok) throw new Error(result.error || 'Slack post failed');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: result.ts }));
      } catch (err) {
        console.error('post-to-slack error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── /ist-backlog-data — IST team backlog (Dnyanesh's 14 direct reports) ──
  if (url.pathname === '/ist-backlog-data') {
    try {
      const IST_OWNER_IDS = [
        '005Hx000009PTEXIA4', // Aditya Shrivastava
        '0053y00000GeydnAAB', // Aishwarya S
        '005Hx00000A7hthIAB', // Ayushi Batra
        '005Hx00000HuZ7lIAF', // Farhanaz Syed
        '005Hx000006boNNIAY', // Khushali Kalyani
        '005Hx000000G9lhIAC', // Kishore Kumar Taank
        '005Hx000002k8uHIAQ', // Manoj Kumar Putta
        '0053y00000GngK8AAJ', // Nasrulla .
        '005Hx000006nR0PIAU', // Neelima Nambaru
        '005Hx000004EOD3IAO', // Pravallika Anthati
        '005Hx00000A3id3IAB', // Puja Mishra
        '005Hx000009A2kvIAC', // Shruthi Veeraraju
        '005Hx000000PHqTIAW', // Talib Hussain
        '005Hx000005jRR1IAM', // Vijayalakshmi Bose
      ];
      const idList = IST_OWNER_IDS.map(id => `'${id}'`).join(',');
      const soql = [
        'SELECT Id, CaseNumber, Subject, Status, Sub_Status__c, Severity_Level__c,',
        'Account.Name, Owner.Name, Age_days__c, Reopen_count__c,',
        'IsEscalated, Management_Escalation_Status__c,',
        'Next_Follow_up_Date__c, Last_Public_Activity_DateTime__c,',
        'cssf_Product_Topic_Name__c, CreatedDate, LastModifiedDate,',
        'GUS_Investigation_Number__c',
        'FROM Case',
        `WHERE IsClosed = false AND OwnerId IN (${idList})`,
        'ORDER BY Age_days__c DESC',
        'LIMIT 2000',
      ].join(' ');
      const result = await mcpSOQL(soql);
      if (!Array.isArray(result.records)) throw new Error('bad ist-backlog response');
      const now = Date.now();
      const cases = result.records.map(c => {
        const sev = normCICSev(c.Severity_Level__c);
        const age = Math.round(c.Age_days__c || 0);
        const lastPub = c.Last_Public_Activity_DateTime__c
          ? Math.floor((now - new Date(c.Last_Public_Activity_DateTime__c).getTime()) / 86400000)
          : null;
        return {
          id:            c.Id,
          caseNum:       c.CaseNumber,
          subject:       (c.Subject || '').slice(0, 120),
          status:        c.Status || '—',
          subStatus:     c.Sub_Status__c || null,
          severity:      sev.label,
          sevBadge:      sev.badge,
          account:       c.Account?.Name || '—',
          owner:         c.Owner?.Name   || '—',
          productTopic:  c.cssf_Product_Topic_Name__c || '—',
          ageDays:       age,
          daysSinceCustomer: lastPub,
          reopens:       c.Reopen_count__c || 0,
          isEscalated:   c.IsEscalated || false,
          mgmtEscalation: c.Management_Escalation_Status__c || null,
          nextFollowUp:  c.Next_Follow_up_Date__c || null,
          lastPublicActivity: c.Last_Public_Activity_DateTime__c || null,
          hasGUS:        !!c.GUS_Investigation_Number__c,
          gusItems:      c.GUS_Investigation_Number__c || null,
          createdDate:   c.CreatedDate,
          lastModified:  c.LastModifiedDate,
          caseUrl:       `https://orgcs.lightning.force.com/lightning/r/Case/${c.Id}/view`,
        };
      });
      // Build byOwner map
      const byOwner = {};
      cases.forEach(c => {
        if (!byOwner[c.owner]) byOwner[c.owner] = [];
        byOwner[c.owner].push(c);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cases, byOwner, total: cases.length, fetchedAt: new Date().toISOString() }));
    } catch (err) {
      if (err.code === 'NEED_AUTH') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NEED_AUTH' }));
      } else {
        console.error('IST backlog error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // ── /backlog — return open team backlog cases ──
  if (url.pathname === '/backlog') {
    try {
      const { cases, byOwner } = await fetchBacklogCases();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cases, byOwner, total: cases.length, fetchedAt: new Date().toISOString() }));
    } catch (err) {
      if (err.code === 'NEED_AUTH') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NEED_AUTH' }));
      } else {
        console.error('Backlog error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // ── /cic — return live CIC cases ──
  if (url.pathname === '/cic') {
    try {
      const cases = await fetchCICCases();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cases, total: cases.length, fetchedAt: new Date().toISOString() }));
    } catch (err) {
      if (err.code === 'NEED_AUTH') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NEED_AUTH' }));
      } else {
        console.error('CIC error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // ── /debug-sig-mce — dump raw messages from Sig MCE channel ──
  if (url.pathname === '/debug-sig-mce') {
    const fromParam = url.searchParams.get('from');
    const toParam   = url.searchParams.get('to');
    if (!fromParam || !toParam) { res.writeHead(400); res.end('Missing from/to'); return; }
    try {
      const oldest = (new Date(fromParam).getTime() / 1000).toFixed(6);
      const latest  = (new Date(toParam).getTime()   / 1000).toFixed(6);
      const messages = await fetchChannelMessages(oldest, latest, SIG_MCE_CHANNEL_ID);
      // Return first 10 messages with full text + blocks so we can see the format
      const sample = messages.slice(0, 10).map(m => ({
        ts:          m.ts,
        type:        m.type,
        subtype:     m.subtype,
        reply_count: m.reply_count,
        text:        m.text,
        blocks:      m.blocks,
        attachments: m.attachments,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: messages.length, sample }, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── /gho — return GHO cases for date range ──
  if (url.pathname !== '/gho' && url.pathname !== '/gho-sig-mce' && url.pathname !== '/gho-marketing-app') {
    res.writeHead(404); res.end('Not found'); return;
  }

  const fromParam = url.searchParams.get('from');
  const toParam   = url.searchParams.get('to');

  if (!fromParam || !toParam) {
    res.writeHead(400); res.end('Missing from/to params'); return;
  }

  const isSigMce       = url.pathname === '/gho-sig-mce';
  const isMarketingApp = url.pathname === '/gho-marketing-app';
  const channelId = isSigMce       ? SIG_MCE_CHANNEL_ID
                  : isMarketingApp ? MARKETING_APP_CHANNEL_ID
                  : CHANNEL_ID;
  const label     = isSigMce       ? 'Sig-MCE GHO'
                  : isMarketingApp ? 'Marketing App GHO'
                  : 'GHO';

  try {
    const oldest = (new Date(fromParam).getTime() / 1000).toFixed(6);
    const latest  = (new Date(toParam).getTime()   / 1000).toFixed(6);
    console.log(`Fetching ${label} ${fromParam} → ${toParam}`);

    const messages = await fetchChannelMessages(oldest, latest, channelId);
    console.log(`Got ${messages.length} messages, parsing ${label}s...`);

    const ghos = messages
      .map(parseGHO)
      .filter(Boolean)
      .map(g => {
        const sev = normSeverity(g.severity);
        g.severity = sev.label;
        g.sevBadge = sev.badge;
        g.plan     = normPlan(g.plan);
        return g;
      });

    console.log(`Found ${ghos.length} ${label} requests, fetching threads...`);

    const enricher = makeEnricher(channelId);
    const enriched = [];
    for (let i = 0; i < ghos.length; i += 3) {
      const batch   = ghos.slice(i, i + 3);
      const results = await Promise.all(batch.map(enricher));
      enriched.push(...results);
    }

    // For Sig MCE / Marketing App: ghoOutcome is determined solely by whether the OWNER button was clicked.
    if (isSigMce || isMarketingApp) {
      enriched.forEach(g => {
        if (g.approvedBy && g.approvedBy !== '—') {
          g.ghoOutcome = 'Accepted';
        } else if (g.ghoOutcome !== 'Rejected') {
          g.ghoOutcome = 'Pending';
        }
      });
    }

    enriched.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cases: enriched, total: enriched.length }));

  } catch (err) {
    console.error(`${label} error:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`GHO API           → http://localhost:${PORT}/gho`);
  console.log(`Sig-MCE API       → http://localhost:${PORT}/gho-sig-mce`);
  console.log(`Marketing App API → http://localhost:${PORT}/gho-marketing-app`);
  console.log(`CIC API           → http://localhost:${PORT}/cic`);
  console.log('');
  console.log('OrgCS token read from Claude Code keychain automatically.');
});
