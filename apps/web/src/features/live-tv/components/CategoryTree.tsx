'use client';

import type { Category } from '@mbolo/contracts';
import { useState } from 'react';

function TreeNode({ node, active, onSelect, depth }: { node: Category; active: string | undefined; onSelect: (slug?: string) => void; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const isActive = active === node.slug;
  return (
    <li>
      <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Réduire le dossier' : 'Déployer le dossier'}
            className="shrink-0 rounded-md px-1 py-1 text-muted hover:bg-surface-3 hover:text-foreground transition-colors"
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(isActive ? undefined : node.slug)}
          className={`flex-1 truncate rounded-lg px-2 py-1 text-left text-sm transition-colors ${
            isActive ? 'bg-accent/15 font-semibold text-accent' : 'text-secondary hover:bg-surface-3'
          }`}
        >
          <span className="truncate">{node.name}</span>
          {node.channelCount ? <span className="ml-2 text-xs text-faint">{node.channelCount}</span> : null}
        </button>
      </div>
      {hasChildren && open && (
        <ul className="mt-0.5 space-y-0.5">
          {children.map((child) => (
            <TreeNode key={child.id} node={child} active={active} onSelect={onSelect} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CategoryTree({ categories, active, onSelect }: { categories: Category[]; active: string | undefined; onSelect: (slug?: string) => void }) {
  return (
    <ul className="space-y-0.5">
      <li>
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          className={`w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
            active === undefined ? 'bg-accent/15 font-semibold text-accent' : 'text-secondary hover:bg-surface-3'
          }`}
        >
          Toutes les chaînes
        </button>
      </li>
      {categories.map((node) => (
        <TreeNode key={node.id} node={node} active={active} onSelect={onSelect} depth={0} />
      ))}
    </ul>
  );
}
