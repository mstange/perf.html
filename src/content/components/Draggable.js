import React, { PureComponent, PropTypes } from 'react';

/**
 * A component that reports mouse dragging (left mouse button only) in its
 * onMove handler.
 * While the mouse button is pressed, onMove is called on each mouse move with
 * three arguments: the value of its 'value' field at mousedown time, and the
 * x and y deltas compared to the mouse position at mousedown.
 * During the drag, the additional className 'dragging' is set on the element.
 */
export default class Draggable extends PureComponent {

  constructor(props) {
    super(props);
    this.state = { dragging: false };
    this._onMouseDown = this._onMouseDown.bind(this);
    this._handlers = null;
    this._container = null;
    this._containerCreated = c => { this._container = c; };
  }

  _onMouseDown(e) {
    if (!this._container || e.button !== 0) {
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    this.setState({ dragging: true });

    const mouseDownX = e.pageX;
    const mouseDownY = e.pageY;
    const startValue = this.props.value;

    const mouseMoveHandler = e => {
      this.props.onMove(startValue, e.pageX - mouseDownX, e.pageY - mouseDownY, true);
      e.stopPropagation();
      e.preventDefault();
    };

    const mouseUpHandler = e => {
      this.props.onMove(startValue, e.pageX - mouseDownX, e.pageY - mouseDownY, false);
      e.stopPropagation();
      e.preventDefault();
      this._uninstallMoveAndUpHandlers();
      this.setState({ dragging: false });
    };

    this._installMoveAndUpHandlers(mouseMoveHandler, mouseUpHandler);
  }

  _installMoveAndUpHandlers(mouseMoveHandler, mouseUpHandler) {
    this._handlers = { mouseMoveHandler, mouseUpHandler };
    window.addEventListener('mousemove', mouseMoveHandler, true);
    window.addEventListener('mouseup', mouseUpHandler, true);
  }

  _uninstallMoveAndUpHandlers() {
    if (this._handlers) {
      const { mouseMoveHandler, mouseUpHandler } = this._handlers;
      window.removeEventListener('mousemove', mouseMoveHandler, true);
      window.removeEventListener('mouseup', mouseUpHandler, true);
    }
  }

  componentWillUnmount() {
    this._uninstallMoveAndUpHandlers();
  }

  render() {
    const props = Object.assign({}, this.props);
    if (this.state.dragging) {
      props.className += ' dragging';
    }
    delete props.onMove;
    delete props.value;
    delete props.children;
    return (
      <div {...props} onMouseDown={this._onMouseDown} ref={this._containerCreated}>
        {this.props.children}
      </div>
    );
  }
}

Draggable.propTypes = {
  value: PropTypes.any,
  onMove: PropTypes.func.isRequired,
  children: PropTypes.node,
};
