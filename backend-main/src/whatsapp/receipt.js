import Big from 'big.js';
import { DateTime } from 'luxon';

const num=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const clean=value=>String(value ?? '').replace(/^\w+:/,'').replace(/\.[PS]$/,'');
const amount=(value,currency='USDT')=>value===null?'Pending':(value>0?'+':'')+value.toLocaleString('en-US',{maximumFractionDigits:4})+' '+currency;
export function receiptData(event,zone='Asia/Dubai') {
 const d=event.data || {},kind=event.kind,currency=d.currency || 'USDT';
 const gross=num(d.grossPnl) ?? (d.pnlIncludesFees?null:num(d.pnl));
 const fees=num(d.totalFees) ?? num(d.fees);
 const complete=d.feesComplete===true&&num(d.totalFees)!==null&&(!d.feeCurrency||d.feeCurrency===currency);
 const net=num(d.netPnl) ?? (d.pnlIncludesFees?num(d.pnl):complete&&gross!==null?new Big(gross).minus(d.totalFees).toNumber():null);
 const exit=['take_profit_hit','stop_loss_hit','trade_closed','pnl_updated'].includes(kind)||kind==='trade_filled'&&(d.role==='tp'||d.role==='sl'||gross!==null&&gross!==0);
 const executed=(kind==='order_accepted'&&['closed','filled'].includes(String(d.status).toLowerCase())&&Number(d.quantity)>0)||kind==='trade_filled'&&!exit;
 let heading='TRADE UPDATE',hero='UPDATE',tone='info',caption='Exchange update';
 if(exit) {
  heading=net!==null?(net>0?'PROFIT':net<0?'LOSS':'BREAK-EVEN'):'RESULT UPDATE';
  hero=net!==null?amount(net,currency):gross!==null?amount(gross,currency):'RESULT PENDING';
  tone=net!==null?(net>0?'profit':net<0?'loss':'info'):'info';
  caption=net!==null?'NET AFTER CONFIRMED FEES':gross!==null?'GROSS PNL - NET PENDING':'Awaiting confirmed result';
 } else if(executed){heading='TRADE EXECUTED';hero=clean(d.symbol)||'ORDER FILLED';caption='Order filled successfully';}
 else if(kind==='monitoring_match'){heading='MONITORING SIGNAL';hero='NO ORDER PLACED';caption='Condition matched - monitoring only';}
 else if(['order_failed','exit_rule_failed'].includes(kind)){heading=kind==='order_failed'?'ORDER FAILED':'TP / SL FAILED';hero='ACTION REQUIRED';tone='warning';caption='Exchange reported an error';}
 else if(kind==='trade_triggered'){heading='STRATEGY TRIGGERED';hero='CONDITION MATCHED';caption='Execution is not yet confirmed';}
 else if(kind==='take_profit_set'||kind==='stop_loss_set'){heading=kind==='take_profit_set'?'TAKE PROFIT SET':'STOP LOSS SET';hero='EXIT ORDER PLACED';caption='Position is still open';}
 else if(kind==='trade_activated'){heading='SETUP SAVED';hero='READY';caption='Waiting for the saved condition';}
 else if(kind==='report'){heading='TRADING SUMMARY';hero='ACCOUNT REPORT';caption='Confirmed recorded exchange data';}
 else if(kind==='test'){heading='TEST NOTIFICATION';hero='SAMPLE DATA';caption='No trade was placed by this test';}
 return {heading,hero,tone,caption,sample:event.source==='sample'||event.source==='test',exit,executed,
  symbol:clean(d.symbol)||'Exchange update',side:String(d.side || '').toUpperCase(),leverage:d.leverage?d.leverage+'x':'',
  account:d.account || 'Exchange account',network:d.network==='testnet'?'BINANCE DEMO':d.network || '',
  setup:d.setupName || 'Exchange trade',time:DateTime.fromMillis(event.occurred_at || Date.now(),{zone}).toFormat('dd LLL yyyy HH:mm:ss')+' · '+zone,
  orderId:d.orderId || '',gross:gross===null?'Pending':amount(gross,currency),
  fees:fees===null?'Pending':(complete?'':d.pnlIncludesFees?'Included / recorded: ':'Recorded only: ')+amount(-fees,d.feeCurrency || currency),
  net:net===null?'Pending complete fees':amount(net,currency),netKnown:net!==null,
  details:exit?[['Coin / side',[clean(d.symbol),d.side&&String(d.side).toUpperCase()].filter(Boolean).join(' · ')],['Entry',d.entryPrice ?? 'Not recorded'],['Exit / fill',d.exitPrice ?? d.price ?? 'Pending'],['Reason',kind==='take_profit_hit'?'Take profit filled':kind==='stop_loss_hit'?'Stop loss filled':kind==='trade_closed'?'Exchange confirmed position closed':'Exchange-confirmed PnL']]
   :[['Entry / fill',d.price ?? 'Pending'],['Quantity',d.quantity ?? 'Pending'],['Margin',d.margin!==undefined?'$'+d.margin:'Not recorded'],['Leverage',d.leverage?d.leverage+'x':'Not recorded'],['Take profit',d.takeProfit || 'Not set'],['Stop loss',d.stopLoss || 'Not set']],
  state:executed?'OPEN - PnL not realized':exit?(d.remainingQuantity===0||d.positionClosed===true?'POSITION CLOSED':'Confirmed exit / PnL update'):caption,
  note:d.error || d.summary || '',feeNote:exit?'Trading fees shown when confirmed. Funding excluded.':'',extraText:''};
}

const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const wrap=(value,limit=62)=>String(value || '').split('\n').flatMap(line=>{
 const rows=[];let row='';for(const token of line.split(/\s+/).flatMap(w=>w.length>limit?w.match(new RegExp('.{1,'+limit+'}','g')):[w])){if((row+' '+token).length>limit){rows.push(row);row=token;}else row+=(row?' ':'')+token;}rows.push(row);return rows;
});
export function receiptSvg(content) {
 const r=content.receipt || {heading:'TRADING UPDATE',hero:'JARVIS',caption:'Trade notification',tone:'info',details:[],setup:'Jarvis',time:'',note:content.text,extraText:'',sample:content.sample};
 const design=content.design || {},palette={info:['#245be0','#eaf1ff'],profit:['#07843d','#e8f6ee'],loss:['#dc182b','#fff0f1'],warning:['#a55b05','#fff5df']};
 const [baseAccent,tint]=palette[r.tone] || palette.info,accent=r.tone==='info'?(design.accent || baseAccent):baseAccent,text=design.text || '#0f172a',muted='#53657b',background=design.background || '#eef4fb';
 const allNotes=[r.note,r.extraText,r.feeNote].filter(Boolean).join('\n'),notes=wrap(allNotes).slice(0,160),chunks=[];
 for(let n=0;n<Math.max(1,Math.ceil(notes.length/16));n++)chunks.push(notes.slice(n*16,n*16+16));
 return chunks.map((noteLines,index)=>{
  const parts=[];let y=80;
  const textAt=(value,x,top,size=24,color=text,weight=400,anchor='start')=>parts.push(`<text x="${x}" y="${top}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${esc(color)}" text-anchor="${anchor}">${esc(value)}</text>`);
  const rule=top=>parts.push(`<path d="M88 ${top}H912" stroke="#dbe4ee"/>`);
  parts.push(`<rect x="68" y="${y}" width="864" height="94" rx="16" fill="${tint}"/>`);
  parts.push(`<circle cx="124" cy="${y+47}" r="28" fill="${accent}"/>`);
  textAt(r.tone==='profit'?'+':r.tone==='loss'?'-':r.tone==='warning'?'!':'✓',124,y+58,34,'#ffffff',700,'middle');
  textAt(r.heading,172,y+58,32,accent,700);y+=132;
  for(const line of wrap(design.title || 'Jarvis',65)){textAt(line,88,y,21,muted,600);y+=26;}y+=46;
  textAt(r.hero,88,y,r.hero.length>24?36:r.hero.length>16?47:68,r.exit?accent:text,700);y+=36;
  textAt(r.caption,88,y,21,muted,500);y+=34;
  if(!r.exit) {textAt([r.side,r.leverage,r.network].filter(Boolean).join(' · '),88,y,21,muted,600);y+=26;}
  rule(y);y+=40;
  if(r.exit) {
   for(const [label,value]of [['Gross PnL',r.gross],['Trading fees',r.fees]]){textAt(label,88,y,24,muted);textAt(value,912,y,24,text,600,'end');y+=44;}
   parts.push(`<rect x="76" y="${y-23}" width="848" height="62" rx="12" fill="${tint}"/>`);textAt('Net result',88,y+17,25,text,700);textAt(r.net,912,y+17,25,r.netKnown?accent:muted,700,'end');y+=76;
  }
  for(const [label,value]of r.details || []){
   const rows=wrap(value,42);textAt(label,88,y,23,muted);
   for(const [lineIndex,line]of rows.entries())textAt(line,912,y+lineIndex*28,23,text,600,'end');
   y+=Math.max(44,rows.length*28+15);
  }
  y+=8;parts.push(`<rect x="76" y="${y}" width="848" height="56" rx="12" fill="${tint}"/>`);textAt(r.state || r.caption,500,y+36,21,accent,600,'middle');y+=86;
  for(const line of noteLines){textAt(line,88,y,19,muted);y+=27;}
  if(noteLines.length)y+=15;rule(y);y+=32;
  for(const line of wrap(r.setup,65)){textAt(line,88,y,19,text,600);y+=26;}
  for(const line of wrap([r.account,r.network].filter(Boolean).join(' · '),65)){textAt(line,88,y,17,muted);y+=25;}
  textAt(r.time,88,y,17,muted);y+=28;
  if(r.orderId){textAt('Order '+r.orderId,88,y,16,muted);y+=26;}
  if(r.sample){textAt('SAMPLE DATA - NO REAL TRADE',88,y,18,accent,700);y+=30;}
  if(chunks.length>1){textAt(`Page ${index+1} / ${chunks.length}`,912,y,16,muted,400,'end');y+=20;}
  const height=y+55;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}"><rect width="100%" height="100%" fill="${esc(background)}"/><rect x="40" y="40" width="920" height="${height-80}" rx="24" fill="#ffffff" stroke="#d4e0ef"/>${parts.join('')}</svg>`;
 });
}
