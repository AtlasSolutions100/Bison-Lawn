import { useState, useRef, useEffect } from 'react';
import { useListMyJobs, useUpdateJob, useCompleteJob, useCreateFieldNote, useListOfferableServices, useAddExtraWork, useRecordOnSitePayment, useGetBillingSettings, Job } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format, addDays, subDays, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { MapPin, Navigation, Clock, CheckCircle2, ChevronLeft, ChevronRight, DollarSign, PackageOpen, Mic, MicOff, NotebookPen, Plus, CreditCard, Ban } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function MyJobs() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { data: jobs, isLoading } = useListMyJobs({ date });

  const nextDay = () => setDate(format(addDays(parseISO(date), 1), 'yyyy-MM-dd'));
  const prevDay = () => setDate(format(subDays(parseISO(date), 1), 'yyyy-MM-dd'));

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-20 bg-card border-b shadow-sm px-4 py-3 flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={prevDay} className="h-10 w-10"><ChevronLeft className="w-6 h-6" /></Button>
        <div className="text-center">
          <div className="text-sm text-muted-foreground font-semibold uppercase tracking-wider">Schedule</div>
          <div className="font-bold text-lg">{format(parseISO(date), 'MMM d, yyyy')}</div>
        </div>
        <Button variant="ghost" size="icon" onClick={nextDay} className="h-10 w-10"><ChevronRight className="w-6 h-6" /></Button>
      </div>

      <div className="p-4 space-y-4 max-w-md mx-auto w-full">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground animate-pulse">Loading jobs...</div>
        ) : !jobs?.length ? (
          <div className="text-center py-12 text-muted-foreground">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-muted-foreground/50" />
            </div>
            <p className="font-medium text-lg">No jobs scheduled.</p>
            <p className="text-sm">Enjoy your day!</p>
          </div>
        ) : (
          jobs.map((job, idx) => (
            <JobCard key={job.id} job={job} index={idx + 1} />
          ))
        )}
      </div>
    </div>
  );
}

function JobCard({ job, index }: { job: Job, index: number }) {
  const updateJob = useUpdateJob();
  const completeJob = useCompleteJob();
  const queryClient = useQueryClient();

  const handleStatus = (status: string) => {
    updateJob.mutate({ id: job.id, data: { status: status as any } }, {
      onSuccess: () => {
        // Optimistic-like update for snappy UI
        queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] });
      }
    });
  };

  const handleComplete = () => {
    completeJob.mutate({ id: job.id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] })
    });
  };

  // One tap, then a native prompt for the reason — same low-friction shape as
  // the status buttons, since the crew is doing this standing in the yard.
  const handleSkip = () => {
    const reason = window.prompt('Why was this job skipped? (e.g. too wet, gate locked, dog out)');
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) return; // the office needs a reason, so a blank entry doesn't send
    updateJob.mutate({ id: job.id, data: { status: 'skipped' as any, skipReason: trimmed } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] })
    });
  };

  const isCompleted = job.status === 'completed';
  const isSkipped = job.status === 'skipped';
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${job.clientAddress}, ${job.city}`)}`;

  return (
    <Card className={`overflow-hidden shadow-md border-border transition-all ${isCompleted ? 'opacity-60 bg-muted/50' : isSkipped ? 'bg-orange-50/40' : 'bg-card'}`}>
      <div className={`h-1.5 w-full ${
        isCompleted ? 'bg-primary' :
        isSkipped ? 'bg-orange-400' :
        job.status === 'in_progress' ? 'bg-blue-500' :
        job.status === 'on_the_way' ? 'bg-accent' :
        'bg-muted-foreground/30'
      }`} />
      <CardContent className="p-0">
        <div className="p-4 border-b bg-card">
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-xs">{index}</span>
              <h3 className="font-bold text-lg leading-tight">{job.clientName}</h3>
            </div>
            {isCompleted && <CheckCircle2 className="w-5 h-5 text-primary" />}
            {isSkipped && <Ban className="w-5 h-5 text-orange-600" />}
          </div>

          {isSkipped && job.skipReason && (
            <p className="text-sm font-medium text-orange-700 bg-orange-100/70 border border-orange-200 rounded-md px-2 py-1">
              Skipped — {job.skipReason}
            </p>
          )}

          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 mt-2 group">
            <MapPin className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0 group-hover:text-primary transition-colors" />
            <div>
              <div className="font-medium text-foreground group-hover:text-primary transition-colors">{job.clientAddress}</div>
              <div className="text-sm text-muted-foreground">{job.city}</div>
            </div>
          </a>
        </div>

        <div className="p-4 space-y-3 bg-muted/10">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-foreground">{job.serviceName}</span>
            <span className="font-bold text-foreground flex items-center"><DollarSign className="w-4 h-4 text-primary" />{job.amount}</span>
          </div>

          {(job.mapNote || job.notes) && (
            <div className="space-y-2 mt-3 pt-3 border-t">
              {job.mapNote && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-accent-foreground">Map Note</span>
                  <p className="text-sm font-medium bg-accent/10 p-2 rounded-md border border-accent/20 text-accent-foreground">{job.mapNote}</p>
                </div>
              )}
              {job.notes && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Office Notes</span>
                  <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{job.notes}</p>
                </div>
              )}
            </div>
          )}

          <PropertyDetails data={job.clientPropertyData} />

          {job.products && job.products.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-2">
                <PackageOpen className="w-3 h-3" /> Products Included
              </span>
              <ul className="text-sm space-y-1">
                {job.products.map(p => (
                  <li key={p.id} className="flex justify-between">
                    <span className="text-foreground">{p.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="px-3 pt-3 border-t bg-card">
          <FieldNoteButton job={job} />
        </div>

        <div className="p-3 bg-card grid grid-cols-2 gap-2">
          {!isCompleted && <AddWorkDialog job={job} />}
          <CollectPaymentDialog job={job} wide={isCompleted} />
        </div>

        {!isCompleted && !isSkipped && (
          <>
            <div className="p-3 bg-card grid grid-cols-3 gap-2">
              {job.status === 'scheduled' && (
                <Button onClick={() => handleStatus('on_the_way')} className="col-span-3 bg-accent text-accent-foreground hover:bg-accent/90 h-12 text-base font-bold shadow-sm">
                  <Navigation className="w-5 h-5 mr-2" /> On The Way
                </Button>
              )}

              {job.status === 'on_the_way' && (
                <>
                  <Button variant="outline" onClick={() => handleStatus('scheduled')} className="h-12 border-2">Back</Button>
                  <Button onClick={() => handleStatus('in_progress')} className="col-span-2 bg-blue-600 hover:bg-blue-700 text-white h-12 text-base font-bold shadow-sm">
                    <Clock className="w-5 h-5 mr-2" /> Start Job
                  </Button>
                </>
              )}

              {job.status === 'in_progress' && (
                <>
                  <Button variant="outline" onClick={() => handleStatus('on_the_way')} className="h-12 border-2">Back</Button>
                  <Button onClick={handleComplete} className="col-span-2 bg-primary hover:bg-primary/90 text-primary-foreground h-12 text-base font-bold shadow-sm">
                    <CheckCircle2 className="w-5 h-5 mr-2" /> Complete
                  </Button>
                </>
              )}
            </div>

            {/* Same one-tap shape as the status buttons above; the reason itself comes from a native prompt */}
            <div className="px-3 pb-3 bg-card">
              <Button
                variant="outline"
                onClick={handleSkip}
                className="w-full h-11 border-2 border-orange-300 text-orange-700 hover:bg-orange-50 font-bold"
              >
                <Ban className="w-4 h-4 mr-2" /> Skip Job
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Anything the crew needs to get onto the property, or to know before walking
 * in. Access details get the loud treatment; the rest are still shown.
 *
 * Reported by a sub: "Gate code did not show up on the job card this morning,
 * had to call the office. It is on the client page though." A contractor cannot
 * open the client page — that view is admin-only — so for him the code may as
 * well not have existed.
 *
 * The pattern below only decides what gets *emphasised*. Every saved detail
 * renders either way, so a label the pattern does not recognise still reaches
 * the person standing at the gate. Getting the emphasis wrong costs a glance;
 * hiding the value costs a phone call.
 */
const ACCESS_LABEL = /gate|code|lock|key|alarm|dog|access|entry|combo/i;

function PropertyDetails({ data }: { data?: Record<string, string> | null }) {
  const details = Object.entries(data ?? {}).filter(
    ([, value]) => value != null && String(value).trim() !== '',
  );
  if (!details.length) return null;

  const access = details.filter(([label]) => ACCESS_LABEL.test(label));
  const rest = details.filter(([label]) => !ACCESS_LABEL.test(label));

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      {access.length > 0 && (
        <div>
          <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
            Access
          </span>
          <div className="mt-1 space-y-1">
            {access.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-3 rounded-md border border-primary/25 bg-primary/10 p-2"
              >
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                {/* Selectable and monospaced: this gets read off a phone at a
                    keypad, and 0/O and 1/l have to be tellable apart. */}
                <span className="select-all font-mono text-base font-bold tracking-wider">
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {rest.length > 0 && (
        <div>
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Property Details
          </span>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {rest.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{label}</span>
                <span className="text-sm font-medium tabular-nums">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AddWorkDialog({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState<string>('');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const { data: services } = useListOfferableServices({ query: { enabled: open, queryKey: ['/api/my/offerable-services'] } });
  const addWork = useAddExtraWork();
  const queryClient = useQueryClient();

  const selected = services?.find(s => String(s.id) === serviceId);
  const qty = Number(quantity) || 0;

  const submit = () => {
    if (!selected || qty <= 0) return;
    setError(null);
    addWork.mutate({ id: job.id, data: { serviceId: selected.id, quantity: qty } }, {
      onSuccess: () => {
        queryClient.invalidateQueries();
        setOpen(false);
        setServiceId('');
        setQuantity('1');
      },
      onError: (e: any) => setError(e?.message || 'Could not add work'),
    });
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="h-11 border-2 font-semibold">
        <Plus className="w-4 h-4 mr-1" /> Add Work
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add One-Time Work</DialogTitle>
          </DialogHeader>
          {services && services.length === 0 ? (
            <p className="text-sm text-muted-foreground">The office hasn't approved any extra services to offer on site yet.</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Service</Label>
                <Select value={serviceId} onValueChange={setServiceId}>
                  <SelectTrigger><SelectValue placeholder="Choose a service" /></SelectTrigger>
                  <SelectContent>
                    {services?.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name} — ${s.price.toFixed(2)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selected?.description && <p className="text-xs text-muted-foreground">{selected.description}</p>}
              </div>
              <div className="space-y-2">
                <Label>Quantity</Label>
                <Input type="number" min="0.01" step="0.5" value={quantity} onChange={e => setQuantity(e.target.value)} />
              </div>
              {selected && qty > 0 && (
                <div className="text-sm font-semibold flex justify-between border-t pt-3">
                  <span>Added to invoice</span>
                  <span>${(selected.price * qty).toFixed(2)}</span>
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!selected || qty <= 0 || addWork.isPending}>
              {addWork.isPending ? 'Adding...' : 'Add to Job'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Record or dictate a field note. Uses the browser's speech recognition when
 * available (dictation), with a plain textarea fallback. Submitting sends the
 * transcript to the office as a reviewable ticket.
 */
function FieldNoteButton({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [usedVoice, setUsedVoice] = useState(false);
  const [sent, setSent] = useState(false);
  const recognitionRef = useRef<any>(null);
  const createNote = useCreateFieldNote();

  const SpeechRecognitionImpl =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;
  const supportsVoice = !!SpeechRecognitionImpl;

  const stopListening = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  };

  useEffect(() => {
    // stop dictation if the dialog closes
    if (!open && listening) stopListening();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const startListening = () => {
    if (!SpeechRecognitionImpl) return;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (event: any) => {
      let chunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) chunk += event.results[i][0].transcript;
      }
      if (chunk) {
        setUsedVoice(true);
        setText(prev => (prev ? `${prev.trim()} ${chunk.trim()}` : chunk.trim()));
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  const handleSubmit = () => {
    if (!text.trim()) return;
    createNote.mutate(
      { id: job.id, data: { transcript: text.trim(), source: usedVoice ? 'voice' : 'typed' } },
      {
        onSuccess: () => {
          setSent(true);
          setTimeout(() => {
            setOpen(false);
            setText('');
            setUsedVoice(false);
            setSent(false);
          }, 1200);
        },
      },
    );
  };

  return (
    <>
      <Button
        variant="outline"
        className="w-full h-11 border-2 font-semibold"
        onClick={() => setOpen(true)}
      >
        <NotebookPen className="w-5 h-5 mr-2" /> Add Note for Office
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Note for the office — {job.clientName}</DialogTitle>
          </DialogHeader>
          {sent ? (
            <div className="py-8 text-center">
              <CheckCircle2 className="w-10 h-10 text-primary mx-auto mb-2" />
              <p className="font-semibold">Sent to the office for review</p>
            </div>
          ) : (
            <>
              <div className="space-y-3 py-2">
                <textarea
                  className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-base"
                  placeholder={supportsVoice ? 'Tap the mic to dictate, or type your note...' : 'Type your note...'}
                  value={text}
                  onChange={e => setText(e.target.value)}
                />
                {supportsVoice && (
                  <Button
                    type="button"
                    variant={listening ? 'destructive' : 'secondary'}
                    className="w-full h-12 text-base font-bold"
                    onClick={listening ? stopListening : startListening}
                  >
                    {listening ? (
                      <><MicOff className="w-5 h-5 mr-2" /> Stop Recording</>
                    ) : (
                      <><Mic className="w-5 h-5 mr-2" /> Dictate Note</>
                    )}
                  </Button>
                )}
                {listening && <p className="text-sm text-center text-muted-foreground animate-pulse">Listening... speak your note</p>}
                <p className="text-xs text-muted-foreground">
                  Your note creates a ticket for the office team to review.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleSubmit} disabled={!text.trim() || createNote.isPending}>
                  {createNote.isPending ? 'Sending...' : 'Send to Office'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CollectPaymentDialog({ job, wide }: { job: Job; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'check' | 'credit_card'>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ total: number; cardFee: number } | null>(null);
  const { data: settings } = useGetBillingSettings({ query: { enabled: open, queryKey: ['/api/billing-settings'] } });
  const recordPayment = useRecordOnSitePayment();
  const queryClient = useQueryClient();

  const amt = Number(amount) || 0;
  const feeApplies = method === 'credit_card' && settings?.cardFeeEnabled && (settings?.cardFeePercent ?? 0) > 0;
  const fee = feeApplies ? Math.round(amt * settings!.cardFeePercent) / 100 : 0;
  const total = Math.round((amt + fee) * 100) / 100;

  const submit = () => {
    if (amt <= 0) return;
    setError(null);
    recordPayment.mutate({ id: job.id, data: { amount: amt, method, reference: reference || undefined } }, {
      onSuccess: (p) => {
        queryClient.invalidateQueries();
        setReceipt({ total: p.amount, cardFee: p.cardFee });
      },
      onError: (e: any) => setError(e?.message || 'Could not record payment'),
    });
  };

  const close = () => {
    setOpen(false);
    setReceipt(null);
    setAmount('');
    setReference('');
    setMethod('cash');
    setError(null);
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} className={`h-11 font-semibold ${wide ? 'col-span-2' : ''}`}>
        <CreditCard className="w-4 h-4 mr-1" /> Collect Payment
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{receipt ? 'Payment Recorded' : 'Collect Payment'}</DialogTitle>
          </DialogHeader>
          {receipt ? (
            <div className="space-y-3 text-center py-2">
              <CheckCircle2 className="w-10 h-10 text-primary mx-auto" />
              <p className="text-2xl font-bold">${receipt.total.toFixed(2)}</p>
              {receipt.cardFee > 0 && (
                <p className="text-sm text-muted-foreground">Includes ${receipt.cardFee.toFixed(2)} card processing fee</p>
              )}
              <p className="text-sm text-muted-foreground">Recorded for {job.clientName}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {job.clientBalance != null && (
                <div className="text-sm flex justify-between bg-muted/50 rounded-md p-2">
                  <span className="text-muted-foreground">Customer balance</span>
                  <span className="font-semibold">${job.clientBalance.toFixed(2)}</span>
                </div>
              )}
              <div className="space-y-2">
                <Label>Amount</Label>
                <Input type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="credit_card">Credit Card</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {method !== 'cash' && (
                <div className="space-y-2">
                  <Label>Reference (check # / last 4)</Label>
                  <Input value={reference} onChange={e => setReference(e.target.value)} />
                </div>
              )}
              {method === 'credit_card' && (
                feeApplies ? (
                  <div className="text-sm bg-accent/10 border border-accent/20 rounded-md p-3 space-y-1">
                    <div className="flex justify-between"><span>Payment</span><span>${amt.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span>Card processing fee ({settings!.cardFeePercent}%)</span><span>${fee.toFixed(2)}</span></div>
                    <div className="flex justify-between font-bold border-t pt-1"><span>Customer pays</span><span>${total.toFixed(2)}</span></div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No card processing fee is configured.</p>
                )
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            {receipt ? (
              <Button onClick={close} className="w-full">Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close}>Cancel</Button>
                <Button onClick={submit} disabled={amt <= 0 || recordPayment.isPending}>
                  {recordPayment.isPending ? 'Recording...' : `Record $${total > 0 ? total.toFixed(2) : '0.00'}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
