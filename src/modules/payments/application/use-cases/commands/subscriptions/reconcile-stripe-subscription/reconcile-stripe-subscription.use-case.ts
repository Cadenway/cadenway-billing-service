import { resolveStripeSubscription } from '../../../../../domain/policies/subscriptions/stripe-subscription.policy.js';
import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';
import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeSubscriptionProvider } from '../../../../ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';
import type { StripeReconciliationUnitOfWork } from '../../../../ports/outbound/transactions/subscriptions/stripe-reconciliation-unit-of-work.port.js';
import type { ReconcileStripeSubscriptionInput } from './reconcile-stripe-subscription.input.js';
import type { ReconcileStripeSubscriptionOutput } from './reconcile-stripe-subscription.output.js';

/** Reconciles an admitted Stripe event against current provider and local authority. */
export class ReconcileStripeSubscription {
  // #region Constructor
  /** Binds external reads and tenant-scoped settlement. */
  public constructor(
    private readonly bindings: StripeBindingReader,
    private readonly provider: StripeSubscriptionProvider,
    private readonly work: StripeReconciliationUnitOfWork,
    private readonly settings: StripeSubscriptionReconciliation['settings'],
  ) {}
  // #endregion

  // #region Methods
  /** Fetches provider state outside the transaction and fences it at settlement. */
  public async execute(
    input: ReconcileStripeSubscriptionInput,
  ): Promise<ReconcileStripeSubscriptionOutput> {
    const snapshot = await this.bindings.read(input.organizationId);
    if (snapshot === null) return { status: 'retry' };
    const subscription = await this.provider.retrieve(snapshot.binding.subscriptionId);

    return this.work.run(input.organizationId, async (transaction) => {
      const current = await transaction.lockBinding();
      if (await transaction.isSettled(input.eventId)) return { status: 'duplicate' };
      if (
        current?.revision !== snapshot.revision ||
        current.binding.customerId !== snapshot.binding.customerId ||
        current.binding.subscriptionId !== snapshot.binding.subscriptionId
      ) {
        return { status: 'retry' };
      }

      const decision = resolveStripeSubscription({
        binding: current.binding,
        settings: this.settings,
        subscription,
        confirmedUsage: await transaction.confirmedUsage(),
      });
      if (decision.kind === 'reconcile') return { status: 'retry' };
      if (decision.kind === 'ignore') {
        await transaction.settle(input.eventId);
        return { status: 'ignored' };
      }
      const result = await transaction.apply(decision);
      if (result === 'deferred') return { status: 'retry' };
      await transaction.settle(input.eventId);
      return { status: result };
    });
  }
  // #endregion
}
