import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/input';
import { Alert, Badge, Skeleton } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useUser } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import type { ManagedUser, Role, Store } from '@/lib/types';
import { cn } from '@/lib/utils';

function UserFormDialog({
  open,
  onOpenChange,
  user,
  stores,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ManagedUser | null;
  stores: Store[];
}) {
  const queryClient = useQueryClient();
  const me = useUser();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('seller');
  const [storeId, setStoreId] = useState('');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isSelf = user?.id === me.id;

  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? '');
    setEmail(user?.email ?? '');
    setRole(user?.role ?? 'seller');
    setStoreId(user?.store_id ? String(user.store_id) : stores.length === 1 ? String(stores[0]!.id) : '');
    setPassword('');
    setActive(user?.active ?? true);
    setError(null);
  }, [open, user, stores]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        email,
        role,
        store_id: storeId ? Number(storeId) : null,
        password,
        ...(user ? { active } : {}),
      };
      return user
        ? api<{ user: ManagedUser }>(`/users/${user.id}`, { method: 'PUT', body })
        : api<{ user: ManagedUser }>('/users', { method: 'POST', body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['stores'] });
      toast.success(user ? 'Usuário atualizado.' : 'Usuário criado. Passe o e-mail e a senha para ele entrar.');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (role === 'seller' && !storeId) return setError('Selecione a loja do vendedor.');
    if ((!user || password) && password.length < 8) return setError('A senha precisa ter pelo menos 8 caracteres.');
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? 'Editar usuário' : 'Novo usuário'}</DialogTitle>
          <DialogDescription>
            Vendedores lançam e veem os pedidos da própria loja. Administradores veem a rede toda.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {error && <Alert variant="danger" title={error} />}
          <Field label="Nome" htmlFor="usuario-nome">
            <Input id="usuario-nome" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="E-mail (usado no login)" htmlFor="usuario-email">
            <Input
              id="usuario-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Perfil" htmlFor="usuario-perfil">
              <NativeSelect
                id="usuario-perfil"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={isSelf}
              >
                <option value="seller">Vendedor</option>
                <option value="admin">Administrador</option>
              </NativeSelect>
            </Field>
            <Field
              label="Loja"
              htmlFor="usuario-loja"
              hint={role === 'admin' ? 'Opcional: loja padrão ao lançar pedidos.' : undefined}
            >
              <NativeSelect id="usuario-loja" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">{role === 'admin' ? 'Nenhuma' : 'Selecione'}</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field
            label={user ? 'Nova senha' : 'Senha'}
            htmlFor="usuario-senha"
            hint={user ? 'Deixe em branco para manter a atual. Trocar a senha encerra as sessões abertas.' : 'Pelo menos 8 caracteres.'}
          >
            <Input
              id="usuario-senha"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!user}
            />
          </Field>
          {user && !isSelf && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
              Acesso ativo (desmarque para bloquear o login)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              {user ? 'Salvar usuário' : 'Criar usuário'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPage() {
  useDocumentTitle('Vendedores');
  const [editing, setEditing] = useState<{ open: boolean; user: ManagedUser | null }>({ open: false, user: null });

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: ManagedUser[] }>('/users').then((r) => r.items),
  });
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ items: Store[] }>('/stores').then((r) => r.items),
  });

  return (
    <div>
      <PageHeader
        title="Vendedores e administradores"
        description="Quem acessa o sistema e em qual loja."
        actions={
          <Button onClick={() => setEditing({ open: true, user: null })}>
            <Plus />
            Novo usuário
          </Button>
        }
      />
      <Card>
        {users.isPending ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !users.data?.length ? (
          <EmptyState title="Nenhum usuário" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="pl-4">Nome</TH>
                <TH>E-mail</TH>
                <TH>Perfil</TH>
                <TH>Loja</TH>
                <TH>Situação</TH>
                <TH className="pr-4">
                  <span className="sr-only">Ações</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {users.data.map((user) => (
                <TR key={user.id} className={cn(!user.active && 'text-muted-foreground')}>
                  <TD className="pl-4 font-medium">{user.name}</TD>
                  <TD>{user.email}</TD>
                  <TD>{user.role === 'admin' ? 'Administrador' : 'Vendedor'}</TD>
                  <TD>{user.store_name ?? '-'}</TD>
                  <TD>
                    <Badge variant={user.active ? 'success' : 'neutral'}>{user.active ? 'Ativo' : 'Bloqueado'}</Badge>
                  </TD>
                  <TD className="pr-4">
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ open: true, user })}>
                        <Pencil />
                        Editar
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <UserFormDialog
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        user={editing.user}
        stores={stores.data ?? []}
      />
    </div>
  );
}
