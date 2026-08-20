"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Coach replies come back as markdown from the model. Render it with tight,
 * chat-sized typography instead of dumping raw asterisks into the bubble.
 */
export function CoachMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="text-white/85">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-white">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="text-white/80 italic">{children}</em>
          ),
          // Headings collapse to a small label — chat bubbles are not documents.
          h1: ({ children }) => <CoachHeading>{children}</CoachHeading>,
          h2: ({ children }) => <CoachHeading>{children}</CoachHeading>,
          h3: ({ children }) => <CoachHeading>{children}</CoachHeading>,
          ul: ({ children }) => (
            <ul className="ml-4 list-disc space-y-1 text-white/85 marker:text-[var(--accent-soft)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-4 list-decimal space-y-1 text-white/85 marker:text-white/40">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          code: ({ children }) => (
            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em] text-[#e8dccb]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-black/30 p-2 font-mono text-[11px] text-[#e8dccb]">
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-white/30 hover:decoration-white"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-white/20 pl-3 text-white/70">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-white/10" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-white/15 px-1.5 py-1 text-left font-medium text-white/70">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-white/5 px-1.5 py-1 align-top">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function CoachHeading({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-[0.12em] text-[var(--accent-soft)] uppercase">
      {children}
    </p>
  );
}
