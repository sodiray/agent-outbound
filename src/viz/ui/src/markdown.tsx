import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

// Lightweight markdown renderer for model-authored text (e.g. the SDR brief).
// The content comes from our own pipeline/DB and is rendered into a scoped
// `.markdown` block. We trust it enough to inject as HTML; if briefs ever render
// untrusted third-party HTML, add a sanitizer here.
export const Markdown = ({ text, className }: { text: string; className?: string }) => {
  if (!text) return null;
  const html = marked.parse(text, { async: false }) as string;
  return (
    <div
      className={`markdown${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
