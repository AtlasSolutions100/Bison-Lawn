import { useState, useRef, useEffect } from 'react';
import { useListMyJobs, useUpdateJob, useCompleteJob, Job } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format, addDays, subDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { MapPin, Navigation, Clock, CheckCircle2, ChevronLeft, ChevronRight, DollarSign, PackageOpen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export default function MyJobs() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { data: jobs, isLoading } = useListMyJobs({ date });

  const nextDay = () => setDate(format(addDays(new Date(date), 1), 'yyyy-MM-dd'));
  const prevDay = () => setDate(format(subDays(new Date(date), 1), 'yyyy-MM-dd'));

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-20 bg-card border-b shadow-sm px-4 py-3 flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={prevDay} className="h-10 w-10"><ChevronLeft className="w-6 h-6" /></Button>
        <div className="text-center">
          <div className="text-sm text-muted-foreground font-semibold uppercase tracking-wider">Schedule</div>
          <div className="font-bold text-lg">{format(new Date(date), 'MMM d, yyyy')}</div>
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

  const isCompleted = job.status === 'completed';
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${job.clientAddress}, ${job.city}`)}`;

  return (
    <Card className={`overflow-hidden shadow-md border-border transition-all ${isCompleted ? 'opacity-60 bg-muted/50' : 'bg-card'}`}>
      <div className={`h-1.5 w-full ${
        isCompleted ? 'bg-primary' : 
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
          </div>
          
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

        {!isCompleted && (
          <div className="p-3 border-t bg-card grid grid-cols-3 gap-2">
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
        )}
      </CardContent>
    </Card>
  );
}
