import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
    // Whether this tab is the visible/active one. Only the active terminal owns
    // the window.term / window.ttyd singletons the vkbd talks to.
    active?: boolean;
    // Bubbles the terminal's title up to the owning tab chip.
    onTitle?: (title: string) => void;
    // Asked once, on mount: true when this mount is a "Restart session", so the
    // first connect carries `restart`. The owner clears its flag on the call.
    takeRestart?: () => boolean;
}

interface State {
    modal: boolean;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;
    private opened = false;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal, props.onTitle);
    }

    async componentDidMount() {
        if (this.props.takeRestart?.()) this.xterm.restartOnNextConnect();
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
        this.opened = true;
        if (this.props.active) this.xterm.activate();
    }

    componentDidUpdate(prev: Props) {
        // Became active (tab switch): claim the singletons and re-fit now that
        // the pane is visible.
        if (this.props.active && !prev.active && this.opened) {
            this.xterm.activate();
        }
    }

    componentWillUnmount() {
        // Sleeping a tab (or closing it): fully release the socket + WebGL.
        this.xterm.destroy();
    }

    render({ id }: Props, { modal }: State) {
        return (
            <div
                id={id}
                ref={c => {
                    this.container = c as HTMLElement;
                }}
            >
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
            </div>
        );
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
