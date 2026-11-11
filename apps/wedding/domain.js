import {randomUUID} from 'node:crypto';
export const collections=['categories','expenses','tasks','guests','contacts','notes'];
export const emptyPlan=()=>({schemaVersion:1,settings:{partner1:'',partner2:'',date:'',venue:'',location:'',budget:0},categories:[],expenses:[],tasks:[],guests:[],contacts:[],notes:[]});
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const text=(value,name,max=200,required=false)=>{const result=String(value??'').trim();if(result.length>max||(required&&!result))fail(`${name} ${!result?'is required':`must be ${max} characters or fewer`}.`);return result;};
const amount=(value,name)=>{if(!Number.isSafeInteger(value)||value<0||value>1e11)fail(`${name} must be a nonnegative USD amount in cents.`);return value;};
const date=(value,name)=>{if(!value)return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(`${name} must be a valid date.`);return value;};
const choice=(value,options,name)=>{if(!options.includes(value))fail(`Choose a valid ${name}.`);return value;};
function email(value){const result=text(value,'Email',254);if(result&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))fail('Enter a valid email address.');return result;}
function website(value){const result=text(value,'Website',500);if(result){try{const url=new URL(result);if(!['http:','https:'].includes(url.protocol))throw Error();}catch{fail('Website must start with https:// or http://.');}}return result;}
function boolean(value,name){if(typeof value!=='boolean')fail(`${name} must be true or false.`);return value;}
export function validateSettings(raw){return {partner1:text(raw.partner1,'First name',80),partner2:text(raw.partner2,'Second name',80),date:date(raw.date,'Wedding date'),venue:text(raw.venue,'Venue',160),location:text(raw.location,'Location',160),budget:amount(raw.budget,'Budget')};}
function reference(value,rows,name){if(!value)return '';if(!rows.some(row=>row.id===value))fail(`Choose an existing ${name}.`);return value;}
export function validateRecord(collection,raw,plan){
 const title=()=>text(raw.title,'Title',200,true);
 switch(collection){
  case 'categories':return {name:text(raw.name,'Category name',80,true),budget:amount(raw.budget,'Category budget'),color:choice(raw.color,['sage','rose','sand','lavender','blue','peach'],'color')};
  case 'expenses':{const cost=amount(raw.amount,'Expense total'),paid=amount(raw.paid,'Paid amount');if(cost===0)fail('Expense total must be greater than zero.');if(paid>cost)fail('Paid amount cannot exceed the expense total.');return {title:title(),categoryId:reference(raw.categoryId,plan.categories,'budget category'),contactId:reference(raw.contactId,plan.contacts,'contact'),amount:cost,paid,date:date(raw.date,'Expense date'),due:date(raw.due,'Payment due date'),notes:text(raw.notes,'Notes',4000)};}
  case 'tasks':return {title:title(),due:date(raw.due,'Due date'),assignee:text(raw.assignee,'Assignee',80),category:text(raw.category,'Category',80),priority:choice(raw.priority,['normal','high','low'],'priority'),done:boolean(raw.done,'Completed')};
  case 'guests':{if(!Number.isSafeInteger(raw.partySize)||raw.partySize<1||raw.partySize>20)fail('Party size must be a whole number from 1 to 20.');return {name:text(raw.name,'Guest name',160,true),email:email(raw.email),phone:text(raw.phone,'Phone',60),group:text(raw.group,'Guest group',80),rsvp:choice(raw.rsvp,['Not invited','Invited','Confirmed','Declined'],'RSVP'),partySize:raw.partySize,table:text(raw.table,'Table',40),dietary:text(raw.dietary,'Dietary needs',300),notes:text(raw.notes,'Notes',2000)};}
  case 'contacts':return {name:text(raw.name,'Contact name',160,true),company:text(raw.company,'Company',160),role:text(raw.role,'Role',80),email:email(raw.email),phone:text(raw.phone,'Phone',60),website:website(raw.website),status:choice(raw.status,['Researching','Contacted','Booked'],'status'),notes:text(raw.notes,'Notes',4000)};
  case 'notes':return {title:title(),body:text(raw.body,'Thoughts',12000,true),tag:text(raw.tag,'Tag',60),color:choice(raw.color,['sage','rose','sand','lavender'],'color'),pinned:boolean(raw.pinned,'Pinned')};
  default:fail('Unknown collection.');
 }
}
export function mutatePlan(current,mutation){
 if(!mutation||typeof mutation!=='object')fail('Choose an action.');
 const plan=structuredClone(current),{action,collection,id,data}=mutation;
 if(action==='settings'){plan.settings=validateSettings(data||{});return plan;}
 if(!collections.includes(collection)||!['create','update','delete'].includes(action))fail('Unknown planning action.');
 const rows=plan[collection];const index=rows.findIndex(row=>row.id===id);
 if(action!=='create'&&index<0)throw Object.assign(Error('This item no longer exists. Refresh your plan.'),{status:404});
 if(action==='delete'){
  if(collection==='categories'&&plan.expenses.some(row=>row.categoryId===id))fail('Move expenses to another category before deleting this category.');
  if(collection==='contacts')plan.expenses=plan.expenses.map(row=>row.contactId===id?{...row,contactId:''}:row);
  rows.splice(index,1);return plan;
 }
 const existing=action==='update'?rows[index]:{};
 const record=validateRecord(collection,{...existing,...data},plan);
 if(collection==='categories'&&rows.some(row=>row.id!==id&&row.name.toLowerCase()===record.name.toLowerCase()))fail('That budget category already exists.');
 const saved={...record,id:existing.id||randomUUID(),createdAt:existing.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
 if(action==='create'){if(rows.length>=5000)fail('This collection has reached its 5,000 item limit.');rows.push(saved);}else rows[index]=saved;
 return plan;
}
export function planSummary(plan){const committed=plan.expenses.reduce((s,r)=>s+r.amount,0),paid=plan.expenses.reduce((s,r)=>s+r.paid,0);return {committed,paid,outstanding:committed-paid,remaining:plan.settings.budget-committed,allocated:plan.categories.reduce((s,r)=>s+r.budget,0),guestCount:plan.guests.reduce((s,r)=>s+r.partySize,0),confirmed:plan.guests.filter(r=>r.rsvp==='Confirmed').reduce((s,r)=>s+r.partySize,0),completed:plan.tasks.filter(r=>r.done).length,taskCount:plan.tasks.length};}
