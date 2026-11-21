"use client";

import { useCallback, useEffect, useRef } from "react";

type TurnstileApi = {
  render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void; theme?: "light" | "dark" | "auto" }) => string;
  remove: (widgetId: string) => void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

const siteKey=process.env.NODE_ENV==="production"?process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY:undefined;
let scriptLoad: Promise<void> | undefined;

function loadTurnstile() {
  if(window.turnstile) return Promise.resolve();
  if(!scriptLoad) scriptLoad=new Promise((resolve,reject)=>{
    const existing=document.getElementById("cloudflare-turnstile-script") as HTMLScriptElement|null;
    const script=existing??document.createElement("script");
    script.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async=true; script.defer=true; script.id="cloudflare-turnstile-script";
    script.onload=()=>resolve(); script.onerror=()=>reject(new Error("Could not load the security check."));
    if(!existing) document.head.appendChild(script);
  });
  return scriptLoad;
}

export function TurnstileCaptcha({ onToken, resetSignal=0 }: { onToken:(token:string)=>void; resetSignal?:number }) {
  const container=useRef<HTMLDivElement>(null);
  const notifyToken=useCallback(onToken,[onToken]);
  useEffect(()=>{
    if(!siteKey || !container.current) return;
    let active=true; let widgetId="";
    notifyToken("");
    void loadTurnstile().then(()=>{
      if(!active || !container.current || !window.turnstile) return;
      widgetId=window.turnstile.render(container.current,{sitekey:siteKey,theme:"light",callback:notifyToken,"expired-callback":()=>notifyToken(""),"error-callback":()=>notifyToken("")});
    }).catch(()=>notifyToken(""));
    return ()=>{active=false;if(widgetId && window.turnstile)window.turnstile.remove(widgetId);};
  },[notifyToken,resetSignal]);
  if(!siteKey) return process.env.NODE_ENV==="production"?<div className="auth-captcha-block" role="alert">Security verification is not configured. Contact the Widesip administrator.</div>:null;
  return <div className="auth-captcha-block"><div ref={container}/><small>Protected by Cloudflare Turnstile.</small></div>;
}
