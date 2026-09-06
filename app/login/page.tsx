import { login } from './actions';
export default async function Login({searchParams}:{searchParams:Promise<{error?:string}>}){
 const {error}=await searchParams;
 return <main className="login"><div className="brand"><span className="monogram">K</span> KVARADONA <small>V3</small></div><section className="login-card"><p className="eyebrow">OPPORTUNITY WORKSPACE</p><h1>Good conversations<br/>start with evidence.</h1><p className="muted">Sign in to review the research, shape the offer, and choose the next step.</p><form action={login}><label>Email address<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error&&<p role="alert" className="error">Sign-in failed. Check your email and password.</p>}<button className="primary">Sign in</button></form><p className="footnote">Named review accounts only. Outreach sending is disabled.</p></section></main>;
}
