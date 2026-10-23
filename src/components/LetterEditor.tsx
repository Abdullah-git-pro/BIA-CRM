'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import {
  Box, Stack, Divider, Tooltip, ToggleButton, Button, Alert, TextField,
} from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import FormatUnderlinedIcon from '@mui/icons-material/FormatUnderlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import FormatAlignCenterIcon from '@mui/icons-material/FormatAlignCenter';
import FormatAlignRightIcon from '@mui/icons-material/FormatAlignRight';
import ImageIcon from '@mui/icons-material/Image';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import TitleIcon from '@mui/icons-material/Title';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import CodeIcon from '@mui/icons-material/Code';

/**
 * The letter, written the way a letter is written.
 *
 * ── Why this is not a textarea of HTML ──────────────────────────────────────
 * Because the people who write the copy are not the people who write the code. A renewal
 * letter is a piece of writing that goes to a customer, and asking for it in raw markup
 * means either the developer writes the agency's words or the agency learns HTML to make a
 * sentence bold.
 *
 * ── What this editor must NOT let through ───────────────────────────────────
 * Its output is not rendered in a browser. It is handed to a print vendor who composes it
 * onto paper, so the usual web affordances are liabilities:
 *
 *   external CSS      there is no stylesheet at the printer; only inline styles survive
 *   web fonts         not loaded; the letter falls back to whatever the renderer has
 *   hosted images     the vendor fetches them from the open internet, and a URL that dies
 *                     between writing and posting prints a gap
 *   scripts           never run, and a letter containing one is simply odd
 *
 * The toolbar is therefore deliberately small: the marks it offers are the ones that
 * survive the trip to paper. Images are embedded rather than linked, for the reason above.
 *
 * ── The source view stays ───────────────────────────────────────────────────
 * Not as a fallback but as an audit. This output is printed and posted, and "what exactly
 * will the vendor receive" has to be answerable by looking, not by trusting the editor.
 */

/**
 * Embedded images are capped, hard.
 *
 * There is no asset hosting in this CRM, so an image has to travel inside the letter as a
 * data URI — which is the right trade here (a hosted URL that 404s on print day is worse
 * than a slightly bigger payload) but means every byte is carried in the template row and
 * in every API call that sends it. Base64 inflates by about a third. 1200px wide at JPEG
 * quality 0.82 is more than a 300dpi letterhead needs and lands comfortably under this.
 */
const MAX_IMAGE_BYTES = 400_000;
const MAX_IMAGE_WIDTH = 1200;

/** Downscale and re-encode in the browser, so a 4MB phone photo cannot reach the vendor. */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read that image.');
  // A white backdrop: a transparent PNG flattened onto nothing prints as black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    // Rough byte size of the base64 payload.
    if (url.length * 0.75 <= MAX_IMAGE_BYTES) return url;
  }
  throw new Error('That image is too large to embed in a letter even after shrinking it.');
}

function Btn({ on, onClick, title, disabled, children }: {
  on?: boolean; onClick: () => void; title: string; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip title={title}>
      <span>
        {/*
          aria-label, because every control here is an icon with no text. Without it a
          screen reader announces "button" nine times in a row, and the tooltip does not
          help — it is a hover affordance, not an accessible name.
        */}
        <ToggleButton
          value={title} selected={!!on} disabled={disabled} size="small"
          aria-label={title}
          onClick={onClick}
          sx={{ border: 'none', px: 0.9, py: 0.4, '&.Mui-selected': { bgcolor: '#e7edf6' } }}
        >
          {children}
        </ToggleButton>
      </span>
    </Tooltip>
  );
}

/**
 * Keep named HTML attributes verbatim through parse and render.
 *
 * TipTap's table nodes model STRUCTURE, not presentation: they carry colspan, rowspan and
 * colwidth, and drop everything else. The direct-mail letter's whole geometry lives in
 * `style`, `width`, `valign` and `align` on the cells, so without this the tables come back
 * as tables and still lay out wrongly — which is worse than losing them outright, because it
 * looks like it worked.
 *
 * Measured by scripts/test-letter-roundtrip.mjs against the live template.
 */
const keepAttrs = (names: readonly string[]) => ({
  addAttributes(this: { parent?: () => Record<string, unknown> }) {
    const base = this.parent?.() ?? {};
    const extra: Record<string, unknown> = {};
    for (const name of names) {
      extra[name] = {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute(name),
        renderHTML: (attrs: Record<string, string | null>) => (
          attrs[name] ? { [name]: attrs[name] } : {}
        ),
      };
    }
    return { ...base, ...extra };
  },
});

const CELL_ATTRS = ['style', 'width', 'valign', 'align'] as const;
const TABLE_ATTRS = ['style', 'width', 'cellpadding', 'cellspacing', 'border'] as const;

export default function LetterEditor({ value, onChange, onRegisterInsert }: {
  value: string;
  onChange: (html: string) => void;
  /** Hands the parent a way to insert text at the cursor — used by the variable chips. */
  onRegisterInsert?: (fn: (text: string) => void) => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // No code blocks in a posted letter — there is nothing to format as code on paper.
        codeBlock: false,
        heading: { levels: [1, 2] },
        link: { openOnClick: false },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: false, allowBase64: true }),
      Link.configure({ openOnClick: false, autolink: false }),
      /**
       * Tables, because the letter is built out of them.
       *
       * Without these the schema cannot hold a table at all, so opening the direct-mail
       * letter flattened its masthead, its product rail and its closing band into a column
       * of loose lines — and the first keystroke in this view would have saved that back
       * over the real one. Measured: 6 tables and 15 cells went to zero.
       *
       * `resizable` is off deliberately. A column width dragged on screen means nothing to
       * a print vendor composing a page, and it would write a colwidth that fights the
       * `width` attributes the letter actually uses.
       */
      Table.extend(keepAttrs(TABLE_ATTRS)).configure({ resizable: false }),
      TableRow.extend(keepAttrs(['style'])),
      TableCell.extend(keepAttrs(CELL_ATTRS)),
      TableHeader.extend(keepAttrs(CELL_ATTRS)),
    ],
    content: value || '',
    // Next renders this on the server first; rendering immediately mismatches hydration.
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: {
        // The on-screen approximation of a page. Not the printed geometry — the vendor's
        // 3.25in address clearance is applied on send, and is called out beside the preview.
        style: 'font-family: Georgia, serif; font-size: 11pt; line-height: 1.5; '
          + 'min-height: 320px; padding: 16px; outline: none;',
      },
    },
  });

  /**
   * Take in an edit made elsewhere — "Start from example", or loading another template —
   * without fighting the editor's own state on every keystroke.
   */
  useEffect(() => {
    if (!editor) return;
    const incoming = value || '';
    if (incoming !== editor.getHTML()) editor.commands.setContent(incoming, { emitUpdate: false });
    // Only when the value is replaced from outside; onUpdate already covers typing.
  }, [value, editor]);

  useEffect(() => {
    if (!editor || !onRegisterInsert) return;
    onRegisterInsert((text: string) => editor.chain().focus().insertContent(text).run());
  }, [editor, onRegisterInsert]);

  const pickImage = useCallback(async (file: File | undefined) => {
    setImgError(null);
    if (!file || !editor) return;
    try {
      const src = await fileToDataUrl(file);
      editor.chain().focus().setImage({ src }).run();
    } catch (e) {
      setImgError(e instanceof Error ? e.message : 'Could not insert that image.');
    }
  }, [editor]);

  if (!editor) {
    return <Box sx={{ border: '1px solid #e4e9f0', borderRadius: 1, minHeight: 380 }} />;
  }

  const e: Editor = editor;

  return (
    <Box>
      <Box sx={{ border: '1px solid #e4e9f0', borderRadius: 1, overflow: 'hidden' }}>
        <Stack
          direction="row"
          sx={{ flexWrap: 'wrap', gap: 0.25, p: 0.5, bgcolor: '#f7f9fc',
            borderBottom: '1px solid #e4e9f0', alignItems: 'center' }}
        >
          <Btn title="Bold" on={e.isActive('bold')} onClick={() => e.chain().focus().toggleBold().run()}>
            <FormatBoldIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Italic" on={e.isActive('italic')} onClick={() => e.chain().focus().toggleItalic().run()}>
            <FormatItalicIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Underline" on={e.isActive('underline')} onClick={() => e.chain().focus().toggleUnderline().run()}>
            <FormatUnderlinedIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Heading" on={e.isActive('heading', { level: 2 })}
            onClick={() => e.chain().focus().toggleHeading({ level: 2 }).run()}>
            <TitleIcon sx={{ fontSize: 18 }} />
          </Btn>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />

          <Btn title="Bulleted list" on={e.isActive('bulletList')}
            onClick={() => e.chain().focus().toggleBulletList().run()}>
            <FormatListBulletedIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Numbered list" on={e.isActive('orderedList')}
            onClick={() => e.chain().focus().toggleOrderedList().run()}>
            <FormatListNumberedIcon sx={{ fontSize: 18 }} />
          </Btn>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />

          <Btn title="Align left" on={e.isActive({ textAlign: 'left' })}
            onClick={() => e.chain().focus().setTextAlign('left').run()}>
            <FormatAlignLeftIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Centre" on={e.isActive({ textAlign: 'center' })}
            onClick={() => e.chain().focus().setTextAlign('center').run()}>
            <FormatAlignCenterIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Align right" on={e.isActive({ textAlign: 'right' })}
            onClick={() => e.chain().focus().setTextAlign('right').run()}>
            <FormatAlignRightIcon sx={{ fontSize: 18 }} />
          </Btn>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />

          <Btn title="Insert an image — embedded in the letter, not linked"
            onClick={() => fileRef.current?.click()}>
            <ImageIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Divider line" onClick={() => e.chain().focus().setHorizontalRule().run()}>
            <HorizontalRuleIcon sx={{ fontSize: 18 }} />
          </Btn>

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 0.5 }} />

          <Btn title="Undo" disabled={!e.can().undo()} onClick={() => e.chain().focus().undo().run()}>
            <UndoIcon sx={{ fontSize: 18 }} />
          </Btn>
          <Btn title="Redo" disabled={!e.can().redo()} onClick={() => e.chain().focus().redo().run()}>
            <RedoIcon sx={{ fontSize: 18 }} />
          </Btn>

          <Box sx={{ flex: 1 }} />

          <Button
            size="small" startIcon={<CodeIcon sx={{ fontSize: 16 }} />}
            onClick={() => setShowSource((s) => !s)}
            sx={{ textTransform: 'none', fontSize: 12 }}
          >
            {showSource ? 'Hide source' : 'Source'}
          </Button>
        </Stack>

        <Box sx={{
          bgcolor: '#fff',
          '& .ProseMirror': { minHeight: 320 },
          '& .ProseMirror p': { margin: '0 0 0.8em' },
          '& .ProseMirror img': { maxWidth: '100%', height: 'auto' },
          '& .ProseMirror hr': { border: 0, borderTop: '1px solid #ccc', margin: '1em 0' },
        }}>
          <EditorContent editor={editor} />
        </Box>
      </Box>

      <input
        ref={fileRef} type="file" accept="image/*" hidden
        onChange={(ev) => { pickImage(ev.target.files?.[0]); ev.target.value = ''; }}
      />

      {imgError && <Alert severity="error" sx={{ mt: 1 }}>{imgError}</Alert>}

      {/*
        The source is editable, not just visible. It is the only way to fix something the
        toolbar cannot express, and the only way to see exactly what the printer receives.
      */}
      {showSource && (
        <TextField
          label="HTML as the vendor will receive it"
          multiline minRows={10} fullWidth sx={{ mt: 1 }}
          value={value}
          onChange={(ev) => onChange(ev.target.value)}
          slotProps={{ input: { sx: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 } } }}
        />
      )}
    </Box>
  );
}
