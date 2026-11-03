import {useEffect,useState} from "react";
import {createPortal} from "react-dom";
import type {RpcClient} from "./protocol";

const MAX_BYTES=2_500_000;
const mimeTypes:Record<string,string>={
  png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",
  svg:"image/svg+xml",pdf:"application/pdf",
  txt:"text/plain",md:"text/markdown",json:"application/json",ts:"text/plain",
  tsx:"text/plain",js:"text/plain",jsx:"text/plain",py:"text/plain",
  csv:"text/plain",log:"text/plain",yaml:"text/plain",yml:"text/plain",
};
function decodeBase64(value:string):Uint8Array{
  const bin=atob(value);
  const result=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)result[i]=bin.charCodeAt(i);
  return result;
}
export default function FileReferenceViewer({
  client,path,onClose,
}:{
  client:RpcClient;path:string;onClose:()=>void;
}){
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  const [text,setText]=useState("");
  const [blobUrl,setBlobUrl]=useState("");
  const [image,setImage]=useState(false);
  const [pdf,setPdf]=useState(false);
  useEffect(()=>{
    let cancelled=false;let objectUrl="";
    const load=async()=>{
      try{
        const meta=await client.request<{isFile:boolean;isDirectory:boolean}>("fs/getMetadata",{path});
        if(!meta.isFile)throw Error(meta.isDirectory?"This path is a directory.":"Not a regular file.");
        const response=await client.request<{dataBase64:string}>("fs/readFile",{path});
        if(cancelled)return;
        if(response.dataBase64.length>MAX_BYTES*1.4)throw Error("File exceeds the 2.5 MB preview limit.");
        const bytes=decodeBase64(response.dataBase64);
        if(bytes.length>MAX_BYTES)throw Error("File exceeds the 2.5 MB preview limit.");
        const ext=path.split(".").at(-1)?.toLowerCase()||"";
        const mime=mimeTypes[ext]||"application/octet-stream";
        if(mime.startsWith("image/")||mime==="application/pdf"){
          // SVG files can include active content. Show them as source, not as an image.
          if(ext==="svg")setText(new TextDecoder("utf-8").decode(bytes));
          else{
            const blob=new Blob([bytes as BlobPart],{type:mime});
            objectUrl=URL.createObjectURL(blob);
            setBlobUrl(objectUrl);
            setImage(mime.startsWith("image/"));setPdf(mime==="application/pdf");
          }
        }else if(mime==="application/octet-stream")
          setText("Binary file; inline preview is unavailable.");
        else setText(new TextDecoder("utf-8").decode(bytes));
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:String(e));}
      finally{if(!cancelled)setLoading(false);}
    };
    void load();
    return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[client,path]);
  return createPortal(<div className="modal-scrim file-reference-scrim" role="presentation"
      onClick={onClose}>
    <section className="file-reference-panel" role="dialog" aria-modal="true"
      aria-label="File preview" onClick={event=>event.stopPropagation()}
      onKeyDown={event=>{if(event.key==="Escape")onClose();}}>
      <div className="file-reference-heading">
        <strong title={path}>{path.split("/").at(-1)||path}</strong>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <small className="file-reference-path">{path}</small>
      {loading?<p>Reading file…</p>:error?<p role="alert">{error}</p>:
        image?<img src={blobUrl} alt={path} className="file-reference-image"/>:
        pdf?<iframe src={blobUrl} title="PDF preview" className="file-reference-pdf" sandbox="allow-scripts"/>:
        <pre className="file-reference-text">{text}</pre>}
    </section>
  </div>,document.body);
}
