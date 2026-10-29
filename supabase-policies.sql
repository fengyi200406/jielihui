-- 接力绘 Supabase 权限策略参考
-- 在 Supabase Dashboard → SQL Editor 中检查并按需执行。
-- 注意：Postgres 的 permissive policies 会以 OR 组合；如果已有更宽松的旧策略，需先审查/删除，避免意外放宽权限。

begin;

-- 公共读数据；业务写入仍由 RLS 限制。
alter table public.admins enable row level security;
alter table public.rounds enable row level security;
alter table public.slots enable row level security;
alter table public.works enable row level security;

revoke all on table public.admins from anon, authenticated;
revoke all on table public.rounds from anon, authenticated;
revoke all on table public.slots from anon, authenticated;
revoke all on table public.works from anon, authenticated;

grant select on table public.rounds, public.slots, public.works to anon, authenticated;
grant select on table public.admins to authenticated;
grant insert, update, delete on table public.rounds, public.slots, public.works to authenticated;

-- admins：登录后的用户只能读取自己的管理员登记行。
drop policy if exists relay_admins_select_self on public.admins;
create policy relay_admins_select_self
  on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

-- 轮次：所有访客可读，只有 admins 表登记的 UID 可以写。
drop policy if exists relay_rounds_public_read on public.rounds;
create policy relay_rounds_public_read
  on public.rounds for select to anon, authenticated using (true);

drop policy if exists relay_rounds_admin_insert on public.rounds;
create policy relay_rounds_admin_insert
  on public.rounds for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_rounds_admin_update on public.rounds;
create policy relay_rounds_admin_update
  on public.rounds for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_rounds_admin_delete on public.rounds;
create policy relay_rounds_admin_delete
  on public.rounds for delete to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

-- 棒位：所有访客可读；匿名用户只能把空棒位认领到自己的 UID；管理员可执行后台管理。
drop policy if exists relay_slots_public_read on public.slots;
create policy relay_slots_public_read
  on public.slots for select to anon, authenticated using (true);

drop policy if exists relay_slots_anonymous_claim on public.slots;
create policy relay_slots_anonymous_claim
  on public.slots for update to authenticated
  using (
    status = 'empty'
    and claimed_by is null
    and (select auth.uid()) is not null
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  )
  with check (
    status = 'taken'
    and claimed_by = (select auth.uid())
    and claimant_name is not null
    and claimed_at is not null
  );

drop policy if exists relay_slots_admin_insert on public.slots;
create policy relay_slots_admin_insert
  on public.slots for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_slots_admin_update on public.slots;
create policy relay_slots_admin_update
  on public.slots for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_slots_admin_delete on public.slots;
create policy relay_slots_admin_delete
  on public.slots for delete to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

-- 作品：公开查看，只有管理员可以上传、改图、删除或设置精选。
drop policy if exists relay_works_public_read on public.works;
create policy relay_works_public_read
  on public.works for select to anon, authenticated using (true);

drop policy if exists relay_works_admin_insert on public.works;
create policy relay_works_admin_insert
  on public.works for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_works_admin_update on public.works;
create policy relay_works_admin_update
  on public.works for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists relay_works_admin_delete on public.works;
create policy relay_works_admin_delete
  on public.works for delete to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

-- 防止同一个 Supabase UID 在同一期并发认领多个棒位。
-- 如果执行时报重复键错误，先检查并清理 slots 中同一 round_id + claimed_by 的重复数据。
create unique index if not exists relay_slots_one_claim_per_round_user
  on public.slots (round_id, claimed_by)
  where claimed_by is not null;

-- works 桶必须是公开桶，getPublicUrl 才能在前台直接显示图片。
insert into storage.buckets (id, name, public)
values ('works', 'works', true)
on conflict (id) do update set public = excluded.public;

-- Storage 上传/删除仅限管理员；公开桶的下载链接无需额外的对象读取策略。
drop policy if exists relay_works_storage_admin_insert on storage.objects;
create policy relay_works_storage_admin_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'works'
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

drop policy if exists relay_works_storage_admin_update on storage.objects;
create policy relay_works_storage_admin_update
  on storage.objects for update to authenticated
  using (
    bucket_id = 'works'
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  )
  with check (
    bucket_id = 'works'
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

drop policy if exists relay_works_storage_admin_delete on storage.objects;
create policy relay_works_storage_admin_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'works'
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

commit;
