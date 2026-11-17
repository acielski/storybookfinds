import React from 'react';
import {FileSpreadsheet, Upload} from 'lucide-react';
import {summarizeWalletReference} from './wallet-reference.js';
import './wallet-reference.css';

const money = cents => cents === null ? '—' : new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(cents / 100);
const entries = count => `${count} ${count === 1 ? 'entry' : 'entries'}`;

export default function WalletReference({records = [], onImport}) {
  const summary = summarizeWalletReference(records);

  return <section className="wallet-reference" aria-labelledby="wallet-reference-title">
    <div className="wallet-reference-heading">
      <span className="wallet-reference-icon"><FileSpreadsheet size={19}/></span>
      <div>
        <h3 id="wallet-reference-title">Imported wallet reference</h3>
        <p className="wallet-reference-source">CSV reference · not updated by API sync</p>
      </div>
      {onImport && <button className="button secondary" onClick={onImport}><Upload size={14}/>Add wallet CSV</button>}
    </div>

    <div className="wallet-reference-dates">
      <span><strong>Record dates as exported</strong>{summary.recordCount ? <span>{summary.earliestRecordDate === summary.latestRecordDate ? <time dateTime={summary.earliestRecordDate}>{summary.earliestRecordDate}</time> : <><span>Earliest <time dateTime={summary.earliestRecordDate}>{summary.earliestRecordDate}</time></span><span>Latest <time dateTime={summary.latestRecordDate}>{summary.latestRecordDate}</time></span></>}</span> : <span>—</span>}</span>
      <span><strong>Source entries in this period</strong><span>{summary.recordCount}</span></span>
    </div>

    <div className="wallet-reference-metrics">
      <div>
        <span>Payout entries in imported CSVs</span>
        <strong>{money(summary.completedPayoutCents)}</strong>
        <small>{entries(summary.completedPayoutCount)} marked completed · transfers</small>
      </div>
      <div>
        <span>Earnings marked processing in CSV</span>
        <strong>{money(summary.processingEarningsCents)}</strong>
        <small>{entries(summary.processingEarningsCount)} · status as exported</small>
      </div>
    </div>

    <p className="wallet-reference-note">These CSVs may be partial or out of date. Dates are record creation dates as exported, with no timezone specified; they are not payout completion or bank deposit dates. The dates above do not show continuous coverage. These totals are not a live wallet balance or confirmation of money received, and are excluded from recorded income.</p>

    {summary.recordCount ? <div className="table-scroll"><table>
      <thead><tr><th scope="col">Record date</th><th scope="col">Description</th><th scope="col">Type</th><th scope="col">Status in CSV</th><th scope="col" className="amount">Net amount</th></tr></thead>
      <tbody>{summary.records.map(row => <tr key={row.key}>
        <td><time dateTime={row.date}>{row.date}</time></td>
        <td className="wallet-description">{row.description}</td>
        <td>{row.kind}</td>
        <td><span className={'status '+row.status}>{row.status}</span></td>
        <td className="amount">{money(row.cents)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="wallet-reference-empty">No imported wallet records in the selected period. Add a wallet CSV to see its reference entries here.</p>}
  </section>;
}
