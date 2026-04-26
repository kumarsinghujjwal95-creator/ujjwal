const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────
let rfqs = [];
let quotes = {};      // rfqId → [quote, ...]
let chatRooms = {};   // roomId → [message, ...]
let notifications = [];

const INSURERS = [
  {
    id: 'bajaj', name: 'Bajaj Allianz GI', short: 'BJ', color: '#E05C00',
    rmName: 'Priya Sharma', uwName: 'Rajesh Kumar',
    baseCommission: 12, renewalBonus: 2, claimRatio: 98.2, settleTime: 18,
    rejectionRatio: 1.8, rmRating: 5, score: 92, cashless: 8200,
    commPayDays: 7, uwResponseHrs: 2,
    personalities: [
      'Hello! RFQ received. Happy to offer our best Motor Fleet rate.',
      'Sure, let me check with underwriting on the premium.',
      'We can reduce premium by ₹12,000 and add engine protection free.',
      'Commission can be enhanced to 12.5% for ₹5Cr+ SI policies.',
      'Claim support priority will be EXPRESS lane for your clients.',
      'Renewal bonus: 2% additional on on-time renewals. Great deal!',
    ]
  },
  {
    id: 'hdfc', name: 'HDFC ERGO', short: 'HD', color: '#004C97',
    rmName: 'Amit Verma', uwName: 'Sunita Rao',
    baseCommission: 11, renewalBonus: 1, claimRatio: 96.8, settleTime: 14,
    rejectionRatio: 3.2, rmRating: 4, score: 85, cashless: 7500,
    commPayDays: 10, uwResponseHrs: 4,
    personalities: [
      'Hi! HDFC ERGO here. Our quote is ready — best claim settlement time!',
      'Fastest 14-day average claim settlement in the industry.',
      'We can add Q3 campaign bonus of ₹10,000 for 5+ policies.',
      'Commission at 11% — can consider 11.5% for long-term partnership.',
      'Cashless network: 7,500+ garages across Maharashtra.',
      'Our UW will review your special conditions within 4 hours.',
    ]
  },
  {
    id: 'icici', name: 'ICICI Lombard', short: 'IC', color: '#003087',
    rmName: 'Deepak Patel', uwName: 'Kavita Nair',
    baseCommission: 10, renewalBonus: 0.5, claimRatio: 94.1, settleTime: 22,
    rejectionRatio: 5.9, rmRating: 4, score: 78, cashless: 9100,
    commPayDays: 15, uwResponseHrs: 8,
    personalities: [
      'Namaste! ICICI Lombard — largest cashless network at 9,100+ garages.',
      'Flat ₹5,000 incentive on issuance + 1% portfolio bonus.',
      'Commission at 10% base, open to negotiation on volume.',
      'UW has reviewed — we can cover the special clauses requested.',
      'Annual bonus 1% on portfolio above ₹50L applies to you.',
      'We will escalate to senior UW for faster approval.',
    ]
  },
  {
    id: 'tata', name: 'TATA AIG', short: 'TA', color: '#1C5BA3',
    rmName: 'Rohit Singh', uwName: 'Meera Joshi',
    baseCommission: 9.5, renewalBonus: 0, claimRatio: 88.4, settleTime: 28,
    rejectionRatio: 11.6, rmRating: 3, score: 69, cashless: 5200,
    commPayDays: 20, uwResponseHrs: 24,
    personalities: [
      'Hello from TATA AIG! Quote submitted for your review.',
      'We offer SME campaign reward of ₹3,000 per policy.',
      'Commission at 9.5% — our underwriting is conservative but reliable.',
      'Will check with UW on the special underwriting notes.',
      'Escalation request sent to senior team. Response in 3–5 days.',
      'We can try to improve commission slightly for fleet deals.',
    ]
  }
];

function getInsurerId(roomId){
  return roomId.replace('broker-sup-','').replace('broker-neg-','').replace('broker-','');
}
function getSmartReply(insurerId, userMsg) {
  const ins = INSURERS.find(i => i.id === insurerId);
  const msg = userMsg.toLowerCase();
  if (msg.includes('premium') || msg.includes('rate') || msg.includes('discount')) {
    return `${ins.rmName} (RM): Our underwriting team is reviewing your premium request. Given the clean claims history, we can offer a special discount. Updated quote will be sent within 2 hours. UW ${ins.uwName} has been notified. ✓`;
  }
  if (msg.includes('commission') || msg.includes('compensation')) {
    return `${ins.rmName} (RM): Commission enhancement request noted! Current base: ${ins.baseCommission}%. I'm escalating to our zonal head for a special approval. You should hear back within 30 min. 📈`;
  }
  if (msg.includes('claim') || msg.includes('settlement')) {
    return `${ins.rmName} (RM): Claim support priority acknowledged. For this policy, your client will get PRIORITY queue — avg settlement ${ins.settleTime} days. I've tagged this account for VIP claim handling. ⚡`;
  }
  if (msg.includes('escalat') || msg.includes('urgent') || msg.includes('approval')) {
    return `${ins.rmName} (RM) + ${ins.uwName} (UW): Escalation flagged as URGENT. UW ${ins.uwName} has been paged. Expected response within ${ins.uwResponseHrs} hours. Ticket ID: ESC-${Math.floor(Math.random()*9000)+1000}. 🔼`;
  }
  if (msg.includes('document') || msg.includes('doc') || msg.includes('kyc')) {
    return `${ins.rmName} (RM): Documents received and logged. Our compliance team will verify within 4 business hours. You will get a confirmation email on your registered ID. 📄`;
  }
  if (msg.includes('renewal') || msg.includes('retain')) {
    return `${ins.rmName} (RM): Renewal support noted. ${ins.renewalBonus > 0 ? `We offer ${ins.renewalBonus}% renewal bonus for on-time renewals.` : 'We will ensure smooth renewal experience.'} I'll set up a 45-day advance reminder. 🔄`;
  }
  // Default using personality pool
  const pool = ins.personalities;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── WEBSOCKET ──────────────────────────────────────────────────────────────
const clients = new Map(); // ws → { userId, rooms: Set }

wss.on('connection', (ws) => {
  const userId = uuidv4();
  clients.set(ws, { userId, rooms: new Set() });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const clientInfo = clients.get(ws);

    if (data.type === 'join_room') {
      const roomId = data.roomId;
      clientInfo.rooms.add(roomId);
      if (!chatRooms[roomId]) chatRooms[roomId] = [];
      // Send history
      ws.send(JSON.stringify({ type: 'history', roomId, messages: chatRooms[roomId] }));
    }

    if (data.type === 'chat_message') {
      const { roomId, text, sender, panelId } = data;
      const insurerId = data.insurerId || getInsurerId(roomId);
      const msg = {
        id: uuidv4(),
        roomId,
        sender,
        text,
        role: 'user',
        panelId: panelId || null,
        timestamp: new Date().toISOString()
      };
      if (!chatRooms[roomId]) chatRooms[roomId] = [];
      chatRooms[roomId].push(msg);

      // Do NOT broadcast user msg back — client already shows it instantly

      // Generate smart RM reply with delay
      const replyDelay = 1200 + Math.random() * 1000;
      setTimeout(() => {
        const ins = INSURERS.find(i => i.id === insurerId);
        const replyText = getSmartReply(insurerId, text);
        const reply = {
          id: uuidv4(),
          roomId,
          sender: ins ? `${ins.rmName} · ${ins.name}` : 'Insurer RM',
          text: replyText,
          role: 'rm',
          insurerId,
          panelId: panelId || null,
          timestamp: new Date().toISOString()
        };
        chatRooms[roomId].push(reply);
        broadcastToRoom(roomId, { type: 'new_message', message: reply });

        // Push notification
        const notif = { id: uuidv4(), text: `New message from ${ins?.rmName || 'RM'} (${ins?.name || ''})`, time: new Date().toISOString(), read: false };
        notifications.unshift(notif);
        broadcastAll({ type: 'notification', notification: notif });
      }, replyDelay);
    }

    if (data.type === 'smart_help') {
      const { roomId, insurerId, helpType } = data;
      const msgs = {
        premium: 'Need Better Premium — requesting special rate from underwriter.',
        claim: 'Need Faster Claim Support — please prioritize claim handling for this client.',
        commission: 'Need Higher Commission — can you offer enhanced compensation?',
        escalate: 'Escalate for Approval — urgent underwriter review required.',
        discount: 'Request Special Discount — high-value corporate client.',
        rm: 'Need Better RM Support — please assign dedicated RM to this account.',
      };
      const text = msgs[helpType] || 'Need assistance with this policy.';
      // Fake as user message then trigger reply
      const fakeMsg = { type: 'chat_message', roomId, insurerId, text, sender: 'You (Broker)' };
      ws.emit && ws.emit('message', JSON.stringify(fakeMsg));
      // Direct process
      const msg = { id: uuidv4(), roomId, sender: 'You (Broker)', text, role: 'user', timestamp: new Date().toISOString() };
      if (!chatRooms[roomId]) chatRooms[roomId] = [];
      chatRooms[roomId].push(msg);
      broadcastToRoom(roomId, { type: 'new_message', message: msg });
      setTimeout(() => {
        const ins = INSURERS.find(i => i.id === insurerId);
        const reply = { id: uuidv4(), roomId, sender: `${ins?.rmName || 'RM'} · ${ins?.name || ''}`, text: getSmartReply(insurerId, text), role: 'rm', insurerId, timestamp: new Date().toISOString() };
        chatRooms[roomId].push(reply);
        broadcastToRoom(roomId, { type: 'new_message', message: reply });
      }, 1400);
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', userId }));
});

function broadcastToRoom(roomId, data) {
  const msg = JSON.stringify(data);
  clients.forEach((info, ws) => {
    if (ws.readyState === WebSocket.OPEN && info.rooms.has(roomId)) {
      ws.send(msg);
    }
  });
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ─── REST API ───────────────────────────────────────────────────────────────
app.get('/api/insurers', (req, res) => res.json(INSURERS));

app.post('/api/rfq', (req, res) => {
  const rfq = { id: `RFQ-2025-${String(900 + rfqs.length + 1)}`, ...req.body, status: 'submitted', createdAt: new Date().toISOString(), quotesReceived: 0 };
  rfqs.unshift(rfq);
  quotes[rfq.id] = [];
  // Simulate quotes arriving
  const selectedInsurers = req.body.insurers || ['bajaj','hdfc','icici','tata'];
  let delay = 1500;
  selectedInsurers.forEach(insId => {
    const ins = INSURERS.find(i => i.id === insId);
    if (!ins) return;
    setTimeout(() => {
      const si = parseFloat(req.body.sumInsured || 5000000);
      const baseRate = { bajaj: 0.0964, hdfc: 0.102, icici: 0.1068, tata: 0.1136 }[insId] || 0.1;
      const premium = Math.round(si * baseRate / 100) * 100;
      const quote = {
        id: uuidv4(), rfqId: rfq.id, insurerId: insId,
        insurerName: ins.name, premium,
        commission: ins.baseCommission, claimRatio: ins.claimRatio,
        settleTime: ins.settleTime, score: ins.score,
        receivedAt: new Date().toISOString(), status: 'received'
      };
      quotes[rfq.id].push(quote);
      rfq.quotesReceived = quotes[rfq.id].length;
      if (rfq.quotesReceived === selectedInsurers.length) rfq.status = 'all_received';
      broadcastAll({ type: 'quote_received', rfqId: rfq.id, quote, total: selectedInsurers.length, received: rfq.quotesReceived });
    }, delay);
    delay += 800 + Math.random() * 600;
  });
  res.json({ success: true, rfq });
});

app.get('/api/rfqs', (req, res) => res.json(rfqs));

app.get('/api/quotes/:rfqId', (req, res) => {
  const { weight_premium = 40, weight_claim = 30, weight_commission = 20, weight_rm = 10 } = req.query;
  const rfqQuotes = (quotes[req.params.rfqId] || []).map(q => {
    const ins = INSURERS.find(i => i.id === q.insurerId);
    const premScore = Math.max(0, 100 - ((q.premium - 400000) / 10000));
    const claimScore = q.claimRatio;
    const commScore = (q.commission / 14) * 100;
    const rmScore = ins ? (ins.rmRating / 5) * 100 : 60;
    const total = (premScore * weight_premium + claimScore * weight_claim + commScore * weight_commission + rmScore * weight_rm) / 100;
    return { ...q, ins, premScore: Math.round(premScore), claimScore: Math.round(claimScore), commScore: Math.round(commScore), rmScore: Math.round(rmScore), weightedScore: Math.round(total) };
  }).sort((a, b) => b.weightedScore - a.weightedScore);
  res.json(rfqQuotes);
});

app.get('/api/notifications', (req, res) => res.json(notifications));
app.post('/api/notifications/read', (req, res) => { notifications.forEach(n => n.read = true); res.json({ ok: true }); });

app.get('/api/stats', (req, res) => res.json({
  activeRfqs: rfqs.filter(r => r.status !== 'closed').length + 24,
  quotesReceived: Object.values(quotes).flat().length + 87,
  policiesIssued: 142,
  commission: '18.4L'
}));

// ─── SEED DATA ──────────────────────────────────────────────────────────────
const seedRfqs = [
  { id:'RFQ-2025-0891', client:'Tata Motors Ltd', type:'Motor Fleet', si:'₹5Cr', status:'all_received', quotesReceived:4, totalInsurers:4, createdAt:new Date().toISOString() },
  { id:'RFQ-2025-0890', client:'ABC Pharma Pvt Ltd', type:'Fire & Allied', si:'₹8Cr', status:'partial', quotesReceived:2, totalInsurers:4, createdAt:new Date().toISOString() },
  { id:'RFQ-2025-0889', client:'Sun Healthcare', type:'Group Health', si:'₹2Cr', status:'decision_pending', quotesReceived:4, totalInsurers:4, createdAt:new Date().toISOString() },
  { id:'RFQ-2025-0888', client:'Reliance Infra Ltd', type:'Marine Cargo', si:'₹12Cr', status:'negotiating', quotesReceived:3, totalInsurers:4, createdAt:new Date().toISOString() },
];
rfqs.push(...seedRfqs);
quotes['RFQ-2025-0891'] = INSURERS.map(ins => ({
  id: uuidv4(), rfqId:'RFQ-2025-0891', insurerId:ins.id, insurerName:ins.name,
  premium: {bajaj:482000,hdfc:510000,icici:534000,tata:568000}[ins.id],
  commission:ins.baseCommission, claimRatio:ins.claimRatio, settleTime:ins.settleTime, score:ins.score,
  receivedAt: new Date().toISOString(), status:'received'
}));

const PORT = 3000;
server.listen(PORT, () => console.log(`\n✅  BrokerQuote Exchange running at http://localhost:${PORT}\n`));
