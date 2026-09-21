/** A sanitized stand-in for the saved contact search of run 8f7242ac, committed so the tests do not
 *  depend on a private audit file outside the repository.
 *
 *  Everything that decides behaviour is preserved exactly as the saved response had it: both people
 *  are placed at the company by the provider, one holds a director title, one a specialist title,
 *  and NEITHER reports a work email. Personal names and provider IDs are replaced, and the refresh
 *  dates are relative so the fixture cannot drift into staleness and change what it proves. */
const daysAgo=(d:number)=>new Date(Date.now()-d*86400000).toISOString();

export const host='v4c.ai';
export const company='v4c.ai';
export const ROLE='Head of Marketing, Demand Generation, or Website/Digital Experience';
export const SERVICE='Website CRO and conversion-path QA';

export const director={id:'fixture-person-director',first_name:'Avery',last_name_obfuscated:'Na***g',
 title:'Marketing Director',has_email:false,last_refreshed_at:daysAgo(25),organization:{name:company}};
export const specialist={id:'fixture-person-specialist',first_name:'Devin',last_name_obfuscated:'Ag***l',
 title:'Global Marketing Specialist',has_email:false,last_refreshed_at:daysAgo(62),organization:{name:company}};

/** The saved primary search: two relevant people at the company, neither reachable. */
export const savedSearch={httpStatus:200,body:{total_entries:2,people:[director,specialist]}};

/** A genuinely different title that only an ALTERNATIVE step's criteria can accept: "Web Manager"
 *  matches none of the campaign sentence's titles, and owns exactly the surface the offer is about. */
export const webManager={id:'fixture-person-web',first_name:'Robin',last_name_obfuscated:'Ke***y',
 title:'Web Manager',has_email:true,last_refreshed_at:daysAgo(10),organization:{name:company}};
export const webManagerPerson={id:webManager.id,name:'Robin Kelley',title:'Web Manager',
 email:'robin@v4c.ai',email_status:'verified',organization_id:'fixture-org',
 organization:{id:'fixture-org',name:company,primary_domain:host},
 employment_history:[{current:true,end_date:null,organization_id:'fixture-org',title:'Web Manager'}]};

/** A second reachable alternative, used to show that one settled unusable reveal exhausts that
 *  person rather than the account. */
export const contentLead={id:'fixture-person-content',first_name:'Sam',last_name_obfuscated:'Ri***a',
 title:'Head of Content',has_email:true,last_refreshed_at:daysAgo(12),organization:{name:company}};
export const contentLeadPerson={id:contentLead.id,name:'Sam Rivera',title:'Head of Content',
 email:'sam@v4c.ai',email_status:'verified',organization_id:'fixture-org',
 organization:{id:'fixture-org',name:company,primary_domain:host},
 employment_history:[{current:true,end_date:null,organization_id:'fixture-org',title:'Head of Content'}]};
