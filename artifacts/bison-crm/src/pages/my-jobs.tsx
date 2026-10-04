import { useState, useRef, useEffect } from 'react';
import { useListMyJobs, useUpdateJob, useCompleteJob, useCreateFieldNote, useListOfferableServices, useAddExtraWork, useGetCurrentUser, useClockInToJob, useClockOutOfJob, useListJobTimeEntries, useListJobPhotos, useUploadJobPhoto, useDeletePhoto, useAcknowledgeJobNote, useListMyProducts, useAddMyJobProduct, useDeleteJobProduct, getListJobTimeEntriesQueryKey, getListJobPhotosQueryKey, PhotoUploadInputContentType, Job, JobPhoto, JobPhotoKind } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format, addDays, subDays, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { MapPin, Navigation, Clock, CheckCircle2, ChevronLeft, ChevronRight, DollarSign, PackageOpen, Mic, MicOff, NotebookPen, Plus, Ban, Camera, Timer, Trash2, LogOut, BookOpen, Wrench, Lock } from 'lucide-react';
import TextClientButton from '@/components/client/text-client-button';
import FieldPaymentDialog from '@/components/billing/field-payment-dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { OnTheWayNotice, TextCustomerButton } from '@/components/crew-customer-contact';

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
  const { toast } = useToast();

  const handleStatus = (status: string) => {
    updateJob.mutate({ id: job.id, data: { status: status as any } }, {
      onSuccess: () => {
        // Optimistic-like update for snappy UI
        queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] });
      },
      // The server refuses Start until the note is opened; say why rather
      // than leaving a button that does nothing.
      onError: (e: any) => toast({ title: 'Could not change the job', description: e?.data?.error || e?.message, variant: 'destructive' }),
    });
  };

  const handleComplete = () => {
    completeJob.mutate({ id: job.id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] }),
      // "Someone is still clocked in" is the one the crew will hit.
      onError: (e: any) => toast({ title: 'Could not complete the job', description: e?.data?.error || e?.message, variant: 'destructive' }),
    });
  };

  // The office's must-read note: Start stays locked until it has been opened.
  const noteLocked = !!job.contractorNote && !job.noteAcknowledgedAt;
  const isTimeBilled = job.billingMode === 'time' && job.hourlyRate != null;
  const clockedHours = (job.clockedMinutes ?? 0) / 60;

  // One tap, then a native prompt for the reason — same low-friction shape as
  // the status buttons, since the crew is doing this standing in the yard.
  const handleSkip = () => {
    const reason = window.prompt('Why was this job skipped? (e.g. too wet, gate locked, dog out)');
    if (reason === null) return; // cancelled
    const trimmed = reason.trim();
    if (!trimmed) return; // the office needs a reason, so a blank entry doesn't send
    updateJob.mutate({ id: job.id, data: { status: 'skipped' as any, skipReason: trimmed } }, {
      onSuccess: (result: any) => {
        queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] });
        // Whether the customer is charged for this is something the crew should
        // hear while they are still standing in the yard, not something the
        // office discovers at invoicing.
        if (result?.skipNotice) {
          toast({
            title: result.skipBillable ? 'Skip recorded — chargeable' : 'Skip recorded — free',
            description: result.skipNotice,
          });
        }
      },
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
          <div className="mt-2">
            <TextClientButton clientId={job.clientId} phone={job.clientPhone ?? null} />
          </div>
        </div>

        <div className="p-4 space-y-3 bg-muted/10">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-foreground">{job.serviceName}</span>
            {isTimeBilled ? (
              <span className="text-right">
                <span className="font-bold text-foreground flex items-center justify-end"><Timer className="w-4 h-4 text-primary mr-1" />${job.hourlyRate!.toFixed(2)}/hr</span>
                <span className="block text-xs text-muted-foreground">
                  {isCompleted
                    ? `Billed $${job.amount.toFixed(2)}`
                    : clockedHours > 0
                      ? `${clockedHours.toFixed(2)} h clocked → $${(clockedHours * job.hourlyRate!).toFixed(2)}`
                      : 'Billed by time — clock in below'}
                </span>
              </span>
            ) : (
              <span className="font-bold text-foreground flex items-center"><DollarSign className="w-4 h-4 text-primary" />{job.amount}</span>
            )}
          </div>

          {job.contractorNote && <MustReadNote job={job} locked={noteLocked} />}

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

          {/* Who else is on this one. "Document crew member on clean ups, add
              crew members to day" — a clean-up is two or three men in one
              truck, and the man who is not the lead needs to know who he is
              meeting there. */}
          {((job.crew?.length ?? 0) > 0 || job.assignedToName) && (
            <div className="mt-3 border-t pt-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">On this job</span>
              <p className="mt-1 text-sm font-medium text-foreground">
                {[job.assignedToName, ...(job.crew ?? []).map(c => c.name)].filter(Boolean).join(', ')}
              </p>
            </div>
          )}

          <PropertyDetails data={job.clientPropertyData} />

          {job.products && job.products.length > 0 && <JobParts job={job} editable={!isCompleted} />}
        </div>

        <div className="px-3 pt-3 border-t bg-card">
          <TimeClock job={job} />
        </div>

        <div className="px-3 pt-3 bg-card">
          <JobPhotos job={job} />
        </div>

        <div className="px-3 pt-3 bg-card">
          <FieldNoteButton job={job} />
        </div>

        {/* GPS-SMS track: text or call this job's customer */}
        <div className="px-3 pt-3 bg-card">
          <TextCustomerButton job={job} />
        </div>

        {!isCompleted && (
          <div className="px-3 pt-3 bg-card grid grid-cols-2 gap-2">
            <AddWorkDialog job={job} />
            <AddPartDialog job={job} />
          </div>
        )}
        <div className="p-3 bg-card grid grid-cols-1 gap-2">
          <FieldPaymentDialog jobId={job.id} clientName={job.clientName} wide />
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
                  {noteLocked ? (
                    <Button disabled className="col-span-2 h-12 text-base font-bold shadow-sm">
                      <Lock className="w-5 h-5 mr-2" /> Open the note first
                    </Button>
                  ) : (
                    <Button onClick={() => handleStatus('in_progress')} className="col-span-2 bg-blue-600 hover:bg-blue-700 text-white h-12 text-base font-bold shadow-sm">
                      <Clock className="w-5 h-5 mr-2" /> Start Job
                    </Button>
                  )}
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

            {/* GPS-SMS track (feedback 49): after On The Way, offer to email the customer the "on the way" document */}
            <OnTheWayNotice job={job} />

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
 * The note the office attached to the assigned service, and the rule that
 * goes with it: nobody starts the job until they have opened it. "Bring the
 * sprinkler key" read after the drive home is no use to anyone. Opening it
 * is recorded on the visit, so the office can see it was read.
 */
function MustReadNote({ job, locked }: { job: Job; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const ack = useAcknowledgeJobNote();
  const queryClient = useQueryClient();

  const gotIt = () => {
    if (job.noteAcknowledgedAt) { setOpen(false); return; }
    ack.mutate({ id: job.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] });
        setOpen(false);
      },
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`w-full text-left rounded-md border-2 p-3 ${locked ? 'border-orange-400 bg-orange-50' : 'border-primary/30 bg-primary/5'}`}
      >
        <span className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${locked ? 'text-orange-800' : 'text-primary'}`}>
          {locked ? <Lock className="w-3 h-3" /> : <BookOpen className="w-3 h-3" />}
          {locked ? 'Read this before you start' : 'Note from the office — read'}
        </span>
        <p className={`mt-1 text-sm ${locked ? 'font-semibold text-orange-900' : 'text-foreground whitespace-pre-wrap'}`}>
          {locked ? 'Tap to open the note.' : job.contractorNote}
        </p>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Note for {job.clientName}</DialogTitle>
          </DialogHeader>
          <p className="text-base font-medium whitespace-pre-wrap py-2">{job.contractorNote}</p>
          <DialogFooter>
            <Button onClick={gotIt} disabled={ack.isPending} className="w-full h-12 text-base font-bold">
              <CheckCircle2 className="w-5 h-5 mr-2" /> {ack.isPending ? 'Saving…' : 'Got it'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The parts and fees on the job, qty × price, and what they add to the bill.
 * A line the crew put on by mistake comes off again right here, as long as
 * the job is not invoiced yet.
 */
function JobParts({ job, editable }: { job: Job; editable: boolean }) {
  const remove = useDeleteJobProduct();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const products = job.products ?? [];
  const total = products.reduce((s, p) => s + p.price * (p.quantity ?? 1), 0);
  return (
    <div className="mt-3 pt-3 border-t">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-2">
        <PackageOpen className="w-3 h-3" /> Parts & extras on this job
      </span>
      <ul className="text-sm space-y-1">
        {products.map(p => (
          <li key={p.id} className="flex items-center justify-between gap-2">
            <span className="text-foreground min-w-0 truncate">{p.name}</span>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-muted-foreground text-xs">{p.quantity ?? 1} × ${p.price.toFixed(2)}</span>
              <span className="font-semibold tabular-nums">${(p.price * (p.quantity ?? 1)).toFixed(2)}</span>
              {editable && (
                <button
                  type="button"
                  aria-label="Remove"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => remove.mutate({ id: p.id }, {
                    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] }),
                    onError: (e: any) => toast({ title: 'Could not remove it', description: e?.data?.error || e?.message, variant: 'destructive' }),
                  })}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between text-sm font-semibold border-t pt-2">
        <span>Added to the invoice</span>
        <span>${total.toFixed(2)}</span>
      </div>
    </div>
  );
}

/**
 * Add a part or fee from the office's list — a bag fee, a sprinkler head —
 * with how many. Same shape as adding extra work; the price is the office's,
 * the crew only says how many.
 */
function AddPartDialog({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [presetId, setPresetId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const { data: parts } = useListMyProducts({ query: { enabled: open, queryKey: ['/api/my/products'] } });
  const addPart = useAddMyJobProduct();
  const queryClient = useQueryClient();

  const selected = parts?.find(p => String(p.id) === presetId);
  const qty = Number(quantity) || 0;

  const submit = () => {
    if (!selected || qty <= 0) return;
    setError(null);
    addPart.mutate({ id: job.id, data: { presetId: selected.id, quantity: qty } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/my/jobs'] });
        setOpen(false);
        setPresetId('');
        setQuantity('1');
      },
      onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not add the part'),
    });
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="h-11 border-2 font-semibold">
        <Wrench className="w-4 h-4 mr-1" /> Add Part / Fee
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add a part or fee</DialogTitle>
          </DialogHeader>
          {parts && parts.length === 0 ? (
            <p className="text-sm text-muted-foreground">The office hasn't put any parts or fees on the list yet.</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Part</Label>
                <Select value={presetId} onValueChange={setPresetId}>
                  <SelectTrigger><SelectValue placeholder="Choose a part" /></SelectTrigger>
                  <SelectContent>
                    {parts?.map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.label} — ${p.price.toFixed(2)}{p.unit ? ` / ${p.unit}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>How many{selected?.unit ? ` (${selected.unit})` : ''}</Label>
                <Input type="number" min="0.01" step="1" inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} />
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
            <Button onClick={submit} disabled={!selected || qty <= 0 || addPart.isPending}>
              {addPart.isPending ? 'Adding...' : 'Add to Job'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

/**
 * A measurement fits beside its label; directions do not. Judged on the value
 * rather than the label so a field nobody anticipated still lands in the right
 * place — 30 characters is about where a value stops fitting the narrow column
 * on a phone.
 */
function isLongDetail(value: string) {
  return value.length > 30 || value.includes('\n');
}

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
          {/* Two columns suit "Turf Sqft 6200". They ruin a sentence: the timer
              and valve directions arrived squeezed into a 130px column with the
              label truncated to "Spr...", which is unreadable on a phone in a
              yard — the one place it has to be read. Anything long, or written
              across lines, gets the full width and its label above it. */}
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {rest.filter(([, value]) => !isLongDetail(value)).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{label}</span>
                <span className="text-sm font-medium tabular-nums">{value}</span>
              </div>
            ))}
          </div>
          {rest.filter(([, value]) => isLongDetail(value)).map(([label, value]) => (
            <div key={label} className="mt-2">
              <span className="text-xs text-muted-foreground">{label}</span>
              <p className="mt-0.5 whitespace-pre-wrap text-sm font-medium leading-snug">{value}</p>
            </div>
          ))}
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

/**
 * Where the phone was when the button was pressed.
 *
 * Resolves to null instead of rejecting, and gives up after a few seconds: the
 * point of the coordinates is to show someone was at the property, but a denied
 * permission, a dead GPS fix or a phone in a metal shed must never stand between
 * a crew and clocking in. The extra timer is not redundant — some browsers call
 * neither callback when the permission prompt is dismissed rather than answered,
 * and the built-in timeout does not fire in that case.
 */
function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: { lat: number; lng: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    navigator.geolocation.getCurrentPosition(
      p => finish({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => finish(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 },
    );
    setTimeout(() => finish(null), 7000);
  });
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function formatMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, '0')}m`;
}

/**
 * Clock in and out of the job in front of you.
 *
 * One control filling the width of the card: this gets pressed with a thumb
 * while holding a trimmer, and a mis-tap puts a wrong timestamp on someone's
 * timesheet. Open state comes from this person's own entry rather than any open
 * entry on the job, because two crew can be on the same property and closing
 * someone else's shift is not on offer.
 */
function TimeClock({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const { data: me } = useGetCurrentUser({ query: { queryKey: ['me'] } });
  const { data: entries } = useListJobTimeEntries(job.id);
  const clockIn = useClockInToJob();
  const clockOut = useClockOutOfJob();
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const mine = entries?.filter(e => e.userId === me?.id) ?? [];
  const open = mine.find(e => !e.clockOutAt) ?? null;
  const loggedMinutes = mine.reduce((sum, e) => sum + (e.minutes ?? 0), 0);
  const busy = clockIn.isPending || clockOut.isPending;

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListJobTimeEntriesQueryKey(job.id) });
  const fail = (e: any) => setError(e?.data?.error || e?.message || 'Could not record the time');

  const punch = async () => {
    setError(null);
    // Location is asked for but never waited on beyond its own timeout, so a
    // phone that cannot get a fix still clocks in — just without the proof.
    const where = await currentPosition();
    const data = { lat: where?.lat ?? null, lng: where?.lng ?? null };
    if (open) {
      clockOut.mutate({ id: job.id, data }, { onSuccess: refresh, onError: fail });
    } else {
      clockIn.mutate({ id: job.id, data }, { onSuccess: refresh, onError: fail });
    }
  };

  return (
    <div className="space-y-2">
      {open && (
        <div className="flex items-center justify-between rounded-md border-2 border-blue-200 bg-blue-50 px-3 py-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700">On Site Since</div>
            <div className="text-sm font-semibold text-blue-900">{format(parseISO(open.clockInAt), 'h:mm a')}</div>
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-blue-900">
            {formatElapsed(now - parseISO(open.clockInAt).getTime())}
          </div>
        </div>
      )}

      <Button
        onClick={punch}
        disabled={busy}
        className={`w-full h-14 text-base font-bold shadow-sm ${
          open
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-primary hover:bg-primary/90 text-primary-foreground'
        }`}
      >
        {open ? <LogOut className="w-5 h-5 mr-2" /> : <Timer className="w-5 h-5 mr-2" />}
        {busy ? 'Saving...' : open ? 'Clock Out' : 'Clock In'}
      </Button>

      {!open && loggedMinutes > 0 && (
        <p className="text-xs text-center text-muted-foreground">
          {formatMinutes(loggedMinutes)} logged on this job
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Longest edge, in pixels, a photo is shrunk to before it is uploaded. */
const MAX_PHOTO_EDGE = 1600;

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the photo'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function isStorableType(type: string): type is PhotoUploadInputContentType {
  return Object.prototype.hasOwnProperty.call(PhotoUploadInputContentType, type);
}

/**
 * Shrink the photo before it leaves the phone.
 *
 * A stock camera shot is ten megapixels and several megabytes, and this is used
 * standing in a yard on one bar of signal — the upload timing out is how the
 * feature fails in practice. Nothing downstream needs more resolution than it
 * takes to see a patch of dead grass. If the browser cannot decode or re-encode
 * the image the original bytes go up unchanged, so a working upload never
 * depends on the resize succeeding.
 */
async function toUploadPayload(
  file: File,
): Promise<{ contentType: PhotoUploadInputContentType; dataBase64: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode failed');
    return { contentType: 'image/jpeg', dataBase64: await readAsBase64(blob) };
  } catch {
    if (!isStorableType(file.type)) {
      throw new Error('That file cannot be saved. Use the camera button to take a photo.');
    }
    return { contentType: file.type, dataBase64: await readAsBase64(file) };
  }
}

const KIND_LABEL: Record<JobPhotoKind, string> = { before: 'Before', after: 'After', other: 'Other' };

/**
 * Take a photo on the job, and see the ones already on it.
 *
 * The three capture buttons carry the label, so nobody has to answer a "what
 * kind of photo is this?" prompt after the camera closes — before/after is the
 * pair the office sends customers, and which one it is was decided before the
 * shot. `capture` makes a phone open the camera straight away; a desktop
 * browser ignores it and opens the file picker instead.
 */
function JobPhotos({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const { data: photos } = useListJobPhotos(job.id);
  const upload = useUploadJobPhoto();
  const [error, setError] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<JobPhotoKind | null>(null);
  const [viewing, setViewing] = useState<JobPhoto | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const kindRef = useRef<JobPhotoKind>('other');

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListJobPhotosQueryKey(job.id) });

  const pick = (kind: JobPhotoKind) => {
    setError(null);
    kindRef.current = kind;
    inputRef.current?.click();
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared immediately so retaking the same shot still fires a change event;
    // otherwise a second attempt after a failure looks like nothing happened.
    e.target.value = '';
    if (!file) return;
    const kind = kindRef.current;
    setPendingKind(kind);
    setError(null);
    try {
      const payload = await toUploadPayload(file);
      await upload.mutateAsync({ id: job.id, data: { ...payload, kind } });
      refresh();
    } catch (err: any) {
      setError(err?.data?.error || err?.message || 'Could not save the photo');
    } finally {
      setPendingKind(null);
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />

      {photos && photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setViewing(p)}
              className="relative aspect-square overflow-hidden rounded-md border bg-muted"
            >
              <img src={p.url} alt={p.caption ?? KIND_LABEL[p.kind]} className="h-full w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                {KIND_LABEL[p.kind]}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {(['before', 'after', 'other'] as JobPhotoKind[]).map(kind => (
          <Button
            key={kind}
            variant="outline"
            onClick={() => pick(kind)}
            disabled={pendingKind != null}
            className="h-14 flex-col gap-0.5 border-2 font-semibold"
          >
            <Camera className="w-5 h-5" />
            <span className="text-xs">{pendingKind === kind ? 'Saving...' : KIND_LABEL[kind]}</span>
          </Button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PhotoViewer photo={viewing} onClose={() => setViewing(null)} onDeleted={refresh} />
    </div>
  );
}

function PhotoViewer({
  photo,
  onClose,
  onDeleted,
}: {
  photo: JobPhoto | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const deletePhoto = useDeletePhoto();

  const remove = () => {
    if (!photo) return;
    if (!window.confirm('Delete this photo? It cannot be brought back.')) return;
    deletePhoto.mutate(
      { id: photo.id },
      {
        onSuccess: () => {
          onDeleted();
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={photo != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {photo ? `${KIND_LABEL[photo.kind]} — ${format(parseISO(photo.takenAt), 'MMM d, h:mm a')}` : ''}
          </DialogTitle>
        </DialogHeader>
        {photo && (
          <>
            <img src={photo.url} alt={photo.caption ?? KIND_LABEL[photo.kind]} className="w-full rounded-md" />
            {photo.uploadedByName && (
              <p className="text-xs text-muted-foreground">Taken by {photo.uploadedByName}</p>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button variant="destructive" onClick={remove} disabled={deletePhoto.isPending}>
            <Trash2 className="w-4 h-4 mr-1" /> {deletePhoto.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
