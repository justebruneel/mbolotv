'use client';

import { FormEvent, useState } from 'react';
const SUPPORT_EMAIL = 'justebruneel@gmail.com';
export default function ContactPage() {
  const [subject, setSubject] = useState('Problème avec Mbolo TV');
  const [message, setMessage] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); const body = `${message}\n\nAppareil / navigateur :\nChaîne concernée :\nHeure du problème :`; window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; };
  return <article className="mx-auto max-w-2xl space-y-8 px-2 py-6 text-foreground"><p className="text-sm font-bold uppercase tracking-[.16em] text-accent">Contact</p><h1 className="text-4xl font-bold tracking-tight">Écrire au support</h1><p className="text-muted">Le message s’ouvre dans ton application email et sera envoyé directement à <a className="font-semibold text-accent hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p><form onSubmit={submit} className="space-y-5"><label className="block"><span className="mb-2 block text-sm font-semibold">Objet</span><input value={subject} onChange={(event) => setSubject(event.target.value)} required className="input" /></label><label className="block"><span className="mb-2 block text-sm font-semibold">Message</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} required rows={8} placeholder="Décris le problème rencontré…" className="input resize-y" /></label><button type="submit" className="btn btn-primary">Ouvrir mon email</button></form></article>;
}
