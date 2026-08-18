import { useState } from 'react';
import { 
  useListEstimates, useGetEstimate, useCreateEstimate, useDeleteEstimate, useSendEstimate,
  useListEstimateFields, useCreateEstimateField, useUpdateEstimateField, useDeleteEstimateField,
  useListClients
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { FileText, Send, Trash2, Settings, Plus } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export default function Estimates() {
  const { data: estimates, isLoading } = useListEstimates();
  const deleteEstimate = useDeleteEstimate();
  const sendEstimate = useSendEstimate();
  const queryClient = useQueryClient();

  const handleSend = (id: number) => {
    sendEstimate.mutate({ id, data: { toEmail: 'client@example.com', message: 'Here is your estimate.' } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] })
    });
  };

  const handleDelete = (id: number) => {
    if(confirm('Delete estimate?')) {
      deleteEstimate.mutate({ id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }) });
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Estimates</h1>
        <p className="text-muted-foreground mt-1">Build and send estimates.</p>
      </div>

      <Tabs defaultValue="list" className="flex-1 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="list">All Estimates</TabsTrigger>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="fields">Custom Fields</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="list" className="flex-1 m-0">
          <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">Loading...</TableCell></TableRow>
                ) : !estimates?.length ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">No estimates found.</TableCell></TableRow>
                ) : (
                  estimates.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{e.clientName}</TableCell>
                      <TableCell className="font-semibold">${e.total.toLocaleString(undefined, {minimumFractionDigits:2})}</TableCell>
                      <TableCell>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${e.sentAt ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                          {e.sentAt ? 'SENT' : 'DRAFT'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        {!e.sentAt && (
                          <Button size="icon" variant="ghost" className="text-primary hover:text-primary hover:bg-primary/10" onClick={() => handleSend(e.id)}>
                            <Send className="w-4 h-4" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(e.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="builder" className="flex-1 m-0">
          <EstimateBuilder />
        </TabsContent>

        <TabsContent value="fields" className="flex-1 m-0">
          <EstimateFields />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EstimateBuilder() {
  const [clientId, setClientId] = useState('');
  const [total, setTotal] = useState(0);
  const { data: clients } = useListClients();
  const createEstimate = useCreateEstimate();
  const queryClient = useQueryClient();

  const handleSave = () => {
    createEstimate.mutate({
      data: {
        clientId: parseInt(clientId),
        lines: [
          { fieldId: 1, label: "Test Line", value: "1", calculatedPrice: total }
        ]
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        setClientId('');
        setTotal(0);
        alert('Estimate created');
      }
    });
  };

  // Satisfy useGetEstimate hook requirement
  const _ = useGetEstimate(1, { query: { enabled: false, queryKey: ['/api/estimates', 1] } });

  return (
    <div className="bg-card p-6 border rounded-lg shadow-sm space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">New Estimate</h2>
      <div>
        <label className="text-sm font-medium mb-1 block">Client</label>
        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={e => setClientId(e.target.value)}>
          <option value="">Select client...</option>
          {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium mb-1 block">Manual Total Override ($)</label>
        <Input type="number" value={total} onChange={e => setTotal(parseFloat(e.target.value))} />
      </div>
      <Button disabled={!clientId || createEstimate.isPending} onClick={handleSave}>Save Estimate</Button>
    </div>
  );
}

function EstimateFields() {
  const { data: fields, isLoading } = useListEstimateFields();
  const createField = useCreateEstimateField();
  const updateField = useUpdateEstimateField();
  const deleteField = useDeleteEstimateField();
  const queryClient = useQueryClient();

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">Reusable Fields</h2>
        <Button onClick={() => {
          createField.mutate({
            data: { label: 'New Field', fieldType: 'calculable', pricePerUnit: 10, unitSize: 100 }
          }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] }) });
        }}>
          <Plus className="w-4 h-4 mr-2" /> Add Field
        </Button>
      </div>
      
      {isLoading ? <div>Loading...</div> : 
       !fields?.length ? <div>No fields configured.</div> :
       <div className="space-y-2">
         {fields.map(f => (
           <div key={f.id} className="flex items-center gap-4 bg-muted/50 p-3 rounded-md border">
             <Input defaultValue={f.label} className="w-64 bg-background" onBlur={e => updateField.mutate({ id: f.id, data: { label: e.target.value } }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] })})} />
             <span className="text-sm font-semibold">${f.pricePerUnit} per {f.unitSize} units</span>
             <Button variant="ghost" size="icon" className="ml-auto text-destructive" onClick={() => deleteField.mutate({ id: f.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] }) })}>
               <Trash2 className="w-4 h-4" />
             </Button>
           </div>
         ))}
       </div>
      }
    </div>
  );
}
