import {isValidElement,useEffect,useId,useState,type ReactNode} from "react";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

/** Render only explicitly fenced diagrams, with active SVG content removed. */
function sanitizeSvg(source:string):string {
  const cleaned=DOMPurify.sanitize(source,{
    USE_PROFILES:{svg:true,svgFilters:true},
    FORBID_TAGS:["script","foreignObject","iframe","object","embed","image","use","a","style"],
    FORBID_ATTR:["href","xlink:href"],
    ALLOW_DATA_ATTR:false,
  });
  if(!/<svg[\s>]/i.test(cleaned))throw new Error("The code does not contain a valid SVG element.");
  const holder=document.createElement("div");
  holder.innerHTML=cleaned;
  for(const element of holder.querySelectorAll("*")){
    for(const attr of Array.from(element.attributes)){
      const value=attr.value;
      const urls=[...value.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)];
      if(urls.some(match=>!match[1].trim().startsWith("#")) ||
         /@import|expression\s*\(|javascript\s*:/i.test(value))
        element.removeAttribute(attr.name);
    }
  }
  return holder.innerHTML;
}

let mermaidModule:Promise<(typeof import("mermaid"))["default"]>|undefined;
function getMermaid(){
  if(!mermaidModule)mermaidModule=import("mermaid").then(({default:mermaid})=>{
    mermaid.initialize({
      startOnLoad:false,
      securityLevel:"strict",
      theme:"default",
      htmlLabels:false,
      flowchart:{htmlLabels:false},
      suppressErrorRendering:true,
    });
    return mermaid;
  });
  return mermaidModule;
}
let diagramSerial=0;
function MermaidDiagram({source}:{source:string}){
  const id=useId().replace(/[^a-zA-Z0-9_-]/g,"");
  const [rendered,setRendered]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{
    let canceled=false;
    const timeout=setTimeout(()=>{
      void getMermaid().then(async mermaid=>{
        const result=await mermaid.render("codex-mermaid-"+id+"-"+(++diagramSerial),source);
        if(!canceled){setRendered(sanitizeSvg(result.svg));setError("");}
      }).catch(reason=>{
        if(!canceled){setRendered("");setError(reason instanceof Error?reason.message:"Invalid Mermaid diagram.");}
      });
    },200);
    return ()=>{canceled=true;clearTimeout(timeout);};
  },[source,id]);
  return <>
    {rendered?<div className="markdown-diagram" role="img" aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{__html:rendered}}/>:null}
    {error?<small className="markdown-diagram-error">Diagram preview unavailable: {error}</small>:null}
    {!rendered&&!error?<small className="markdown-diagram-loading">Rendering Mermaid diagram…</small>:null}
  </>;
}
function SvgDiagram({source}:{source:string}){
  const result=(()=>{
    try {return {svg:sanitizeSvg(source),error:""};}
    catch(error){return {svg:"",error:error instanceof Error?error.message:"Invalid SVG."};}
  })();
  return result.svg?
    <div className="markdown-diagram" role="img" aria-label="SVG diagram"
      dangerouslySetInnerHTML={{__html:result.svg}}/>:
    <small className="markdown-diagram-error">SVG preview unavailable: {result.error}</small>;
}

export function MarkdownCodeBlock({children}:{children?:ReactNode}){
  const child=isValidElement<{className?:string;children?:ReactNode}>(children)?children:null;
  const language=child?.props.className?.match(/(?:^|\s)language-([\w+.-]+)/)?.[1]?.toLowerCase()||"";
  const raw=child?.props.children;
  const source=(typeof raw==="string"?raw:Array.isArray(raw)?raw.join(""):String(raw??"")).replace(/\n$/,"");
  const diagram=language==="mermaid"?"mermaid":language==="svg"?"svg":null;
  const [showSource,setShowSource]=useState(false);
  const [copied,setCopied]=useState(false);
  let highlighted="";
  if(!diagram&&language&&hljs.getLanguage(language)){
    try {
      highlighted=DOMPurify.sanitize(hljs.highlight(source,{language,ignoreIllegals:true}).value,{
        ALLOWED_TAGS:["span"],ALLOWED_ATTR:["class"]
      });
    }catch{highlighted="";}
  }
  const copy=async()=>{
    try {
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(source);
      else {
        const textarea=document.createElement("textarea");
        textarea.value=source;textarea.style.position="fixed";textarea.style.opacity="0";
        document.body.appendChild(textarea);textarea.select();
        const success=document.execCommand("copy");textarea.remove();
        if(!success)throw new Error("Clipboard unavailable");
      }
      setCopied(true);
    }catch{setCopied(false);}
  };
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar">
      <span>{language||"text"}</span>
      <div>
        {diagram?<button type="button" onClick={()=>setShowSource(value=>!value)}>
          {showSource?"Hide code":"Show code"}
        </button>:null}
        <button type="button" onClick={()=>void copy()}>{copied?"Copied":"Copy"}</button>
      </div>
    </div>
    {diagram?(language==="mermaid"?<MermaidDiagram source={source}/>:<SvgDiagram source={source}/>):null}
    {!diagram||showSource?<pre className="markdown-code-source">
      {highlighted?<code className="hljs" dangerouslySetInnerHTML={{__html:highlighted}}/>:
        <code>{source}</code>}
    </pre>:null}
  </div>;
}
