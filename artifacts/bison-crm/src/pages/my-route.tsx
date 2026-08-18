import { useState } from 'react';
import { useGetMyRoute } from '@workspace/api-client-react';
import { format, addDays, subDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Map, Navigation } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export default function MyRoute() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { data: route, isLoading } = useGetMyRoute({ date });

  const nextDay = () => setDate(format(addDays(new Date(date), 1), 'yyyy-MM-dd'));
  const prevDay = () => setDate(format(subDays(new Date(date), 1), 'yyyy-MM-dd'));

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-20 bg-card border-b shadow-sm px-4 py-3 flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={prevDay} className="h-10 w-10"><ChevronLeft className="w-6 h-6" /></Button>
        <div className="text-center">
          <div className="text-sm text-muted-foreground font-semibold uppercase tracking-wider">Route Plan</div>
          <div className="font-bold text-lg">{format(new Date(date), 'MMM d, yyyy')}</div>
        </div>
        <Button variant="ghost" size="icon" onClick={nextDay} className="h-10 w-10"><ChevronRight className="w-6 h-6" /></Button>
      </div>

      <div className="p-4 space-y-4 max-w-md mx-auto w-full">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground animate-pulse">Calculating route...</div>
        ) : !route?.stops?.length ? (
          <div className="text-center py-12 text-muted-foreground">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Map className="w-8 h-8 text-muted-foreground/50" />
            </div>
            <p className="font-medium text-lg">No jobs for this date.</p>
          </div>
        ) : (
          <>
            <div className="bg-primary/10 border border-primary/20 text-primary p-4 rounded-xl flex items-center justify-between shadow-sm">
              <span className="font-bold">Total Est. Distance</span>
              <span className="text-xl font-black">{(route.totalDistanceKm * 0.621).toFixed(1)} mi</span>
            </div>

            <div className="relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent pt-2">
              {route.stops.map((stop: any, idx: number) => {
                const mapsUrl = stop.address !== 'Home Base' 
                  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address)}`
                  : undefined;

                return (
                  <div key={idx} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active mb-6">
                    <div className={`flex items-center justify-center w-10 h-10 rounded-full border-4 border-background shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10
                      ${stop.type === 'base' ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground font-bold'}
                    `}>
                      {stop.type === 'base' ? <Map className="w-4 h-4" /> : idx}
                    </div>
                    
                    <Card className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] shadow-sm border-border">
                      <CardContent className="p-3">
                        <div className="font-bold text-foreground text-sm">{stop.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 mb-2 leading-tight">{stop.address}</div>
                        
                        {mapsUrl && (
                          <Button asChild variant="outline" size="sm" className="w-full h-8 text-xs font-semibold">
                            <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                              <Navigation className="w-3 h-3 mr-1" /> Navigate
                            </a>
                          </Button>
                        )}
                        
                        {idx < route.stops.length - 1 && stop.distanceToNext && (
                          <div className="absolute -bottom-5 left-10 md:left-auto md:right-auto md:w-full text-center text-[10px] font-bold text-muted-foreground bg-background px-1 z-20">
                            {stop.distanceToNext} mi
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
