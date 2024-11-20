import EventEmitter from 'events';

/**
 * Base interface for all atomic actions
 */
export interface AtomicAction {
    type: string;
    payload: any;
}

/**
 * Base interface for all atomic reactions
 */
export interface AtomicReaction {
    type: string;
    payload: any;
}

/**
 * Base interface for agent state
 */
export interface AgentState {
    [key: string]: any;
}

/**
 * Base class for atomic agents following the BrainBlend AI atomic-agents pattern
 * See: https://github.com/BrainBlend-AI/atomic-agents
 */
export abstract class AtomicAgent<
    TAction extends AtomicAction,
    TReaction extends AtomicReaction,
    TState extends AgentState
> extends EventEmitter {
    protected state: TState;

    constructor(initialState: TState) {
        super();
        this.state = initialState;
        this.setupActionHandlers();
    }

    /**
     * Set up handlers for atomic actions
     */
    protected abstract setupActionHandlers(): void;

    /**
     * Update agent state with new values
     */
    protected updateState(updates: Partial<TState>) {
        this.state = { ...this.state, ...updates };
        this.emit('stateChanged', this.state);
    }

    /**
     * Get current agent state
     */
    public getState(): TState {
        return { ...this.state };
    }

    /**
     * Dispatch an action to the agent
     */
    public dispatch(action: TAction) {
        this.emit('action', action);
    }

    /**
     * Emit a reaction from the agent
     */
    protected react(reaction: TReaction) {
        this.emit('reaction', reaction);
    }
}
