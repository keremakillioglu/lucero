import { Model } from 'mongoose';
import type { ISavedView } from '~/types/savedView';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import savedViewSchema from '~/schema/savedView';

export function createSavedViewModel(mongoose: typeof import('mongoose')): Model<ISavedView> {
  applyTenantIsolation(savedViewSchema);
  return mongoose.models.SavedView || mongoose.model<ISavedView>('SavedView', savedViewSchema);
}
