/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import React, { PureComponent } from 'react';
import { MenuItem } from '@firefox-devtools/react-contextmenu';
import { Localized } from '@fluent/react';

import './TrackContextMenu.css';
import {
  hideGlobalTrack,
  showAllTracks,
  showGlobalTrack,
  showGlobalTrackIncludingLocalTracks,
  isolateProcess,
  isolateLocalTrack,
  isolateProcessMainThread,
  isolateScreenshot,
  hideLocalTrack,
  showLocalTrack,
  showProvidedTracks,
  hideProvidedTracks,
} from 'firefox-profiler/actions/profile-view';
import explicitConnect from 'firefox-profiler/utils/connect';
import {
  assertExhaustiveCheck,
  ensureExists,
} from 'firefox-profiler/utils/types';
import {
  getThreads,
  getProcesses,
  getRightClickedTrack,
  getGlobalTracks,
  getRightClickedThreadIndex,
  getLocalTrackNamesByPid,
  getGlobalTrackNames,
  getLocalTracksByPid,
} from 'firefox-profiler/selectors/profile';
import {
  getGlobalTrackOrder,
  getHiddenGlobalTracks,
  getHiddenLocalTracksByProcessIndex,
  getLocalTrackOrderByProcessIndex,
} from 'firefox-profiler/selectors/url-state';
import { TrackSearchField } from 'firefox-profiler/components/shared/TrackSearchField';
import {
  getSearchFilteredGlobalTracks,
  getSearchFilteredLocalTracksByPid,
  getTypeFilteredGlobalTracks,
  getTypeFilteredLocalTracksByPid,
} from 'firefox-profiler/profile-logic/tracks';
import { ContextMenuNoHidingOnEnter } from 'firefox-profiler/components/shared/ContextMenuNoHidingOnEnter';
import classNames from 'classnames';
import { intersectSets } from 'firefox-profiler/utils/set';

import type {
  RawThread,
  RawProcess,
  ThreadIndex,
  Pid,
  TrackIndex,
  GlobalTrack,
  LocalTrack,
  State,
  TrackReference,
} from 'firefox-profiler/types';

import type { ConnectedProps } from 'firefox-profiler/utils/connect';

type StateProps = {
  readonly threads: RawThread[];
  readonly processes: RawProcess[];
  readonly globalTrackOrder: TrackIndex[];
  readonly hiddenGlobalTracks: Set<TrackIndex>;
  readonly hiddenLocalTracksByProcessIndex: Map<number, Set<TrackIndex>>;
  readonly localTrackOrderByProcessIndex: Map<number, TrackIndex[]>;
  readonly rightClickedTrack: TrackReference | null;
  readonly globalTracks: GlobalTrack[];
  readonly rightClickedThreadIndex: ThreadIndex | null;
  readonly globalTrackNames: string[];
  readonly localTracksByPid: Map<Pid, LocalTrack[]>;
  readonly localTrackNamesByPid: Map<Pid, string[]>;
};

type DispatchProps = {
  readonly hideGlobalTrack: typeof hideGlobalTrack;
  readonly showAllTracks: typeof showAllTracks;
  readonly showGlobalTrack: typeof showGlobalTrack;
  readonly showGlobalTrackIncludingLocalTracks: typeof showGlobalTrackIncludingLocalTracks;
  readonly isolateProcess: typeof isolateProcess;
  readonly hideLocalTrack: typeof hideLocalTrack;
  readonly showLocalTrack: typeof showLocalTrack;
  readonly isolateLocalTrack: typeof isolateLocalTrack;
  readonly isolateProcessMainThread: typeof isolateProcessMainThread;
  readonly isolateScreenshot: typeof isolateScreenshot;
  readonly showProvidedTracks: typeof showProvidedTracks;
  readonly hideProvidedTracks: typeof hideProvidedTracks;
};

type TimelineTrackContextMenuProps = ConnectedProps<
  {},
  StateProps,
  DispatchProps
>;

type TimelineTrackContextMenuState = {
  searchFilter: string;
};

class TimelineTrackContextMenuImpl extends PureComponent<
  TimelineTrackContextMenuProps,
  TimelineTrackContextMenuState
> {
  override state = { searchFilter: '' };
  _globalTrackClickTimeout: NodeJS.Timeout | null = null;
  _trackSearchFieldElem: { current: TrackSearchField | null } =
    React.createRef();

  _showAllTracks = (): void => {
    const { showAllTracks } = this.props;
    showAllTracks();
  };

  _showMatchingTracks = (): void => {
    const {
      showProvidedTracks,
      globalTracks,
      globalTrackNames,
      localTracksByPid,
      localTrackNamesByPid,
      threads,
      processes,
    } = this.props;
    const { searchFilter } = this.state;
    const searchFilteredGlobalTracks = getSearchFilteredGlobalTracks(
      globalTracks,
      globalTrackNames,
      threads,
      processes,
      searchFilter
    );
    const searchFilteredLocalTracksByPid = getSearchFilteredLocalTracksByPid(
      localTracksByPid,
      localTrackNamesByPid,
      threads,
      processes,
      searchFilter
    );

    if (
      searchFilteredGlobalTracks === null ||
      searchFilteredLocalTracksByPid === null
    ) {
      // This shouldn't happen!
      return;
    }

    // We need to check each global tracks and add their local tracks to the
    // filter as well to make them visible. Also convert from pid-keyed to
    // processIndex-keyed maps.
    const localTracksByProcessIndexToShow = new Map<number, Set<TrackIndex>>();
    // Add search-filtered local tracks (convert from pid to processIndex).
    for (const [pid, filteredTracks] of searchFilteredLocalTracksByPid) {
      const globalTrack = globalTracks.find(
        (t) => t.type === 'process' && t.pid === pid
      );
      if (globalTrack?.type === 'process') {
        localTracksByProcessIndexToShow.set(
          globalTrack.processIndex,
          filteredTracks
        );
      }
    }
    // For global tracks selected by search, also show all their local tracks.
    for (const globalTrackIndex of searchFilteredGlobalTracks) {
      const globalTrack = globalTracks[globalTrackIndex];
      if (globalTrack.type !== 'process') {
        continue;
      }

      // Get all the local tracks and provided ones.
      const localTracks = ensureExists(
        localTracksByPid.get(globalTrack.pid),
        'Expected to find local tracks for the given pid'
      );
      const localTracksToShow = localTracksByProcessIndexToShow.get(
        globalTrack.processIndex
      );
      // Check if their lengths are the same. If not, we must add all the local
      // track indexes.
      if (
        localTracksToShow === undefined ||
        localTracks.length !== localTracksToShow.size
      ) {
        // If they don't match, automatically show all the local tracks.
        localTracksByProcessIndexToShow.set(
          globalTrack.processIndex,
          new Set(localTracks.keys())
        );
      }
    }

    showProvidedTracks(
      searchFilteredGlobalTracks,
      localTracksByProcessIndexToShow
    );
  };

  _hideMatchedTracks = (): void => {
    const {
      globalTracks,
      globalTrackNames,
      localTracksByPid,
      localTrackNamesByPid,
      threads,
      processes,
      hideProvidedTracks,
    } = this.props;
    const { searchFilter } = this.state;
    const searchFilteredGlobalTracks = getSearchFilteredGlobalTracks(
      globalTracks,
      globalTrackNames,
      threads,
      processes,
      searchFilter
    );
    const searchFilteredLocalTracksByPid = getSearchFilteredLocalTracksByPid(
      localTracksByPid,
      localTrackNamesByPid,
      threads,
      processes,
      searchFilter
    );

    if (
      searchFilteredGlobalTracks === null ||
      searchFilteredLocalTracksByPid === null
    ) {
      // This shouldn't happen!
      console.warn('Unexpected null search filtered tracks');
      return;
    }

    // Convert from pid-keyed to processIndex-keyed map.
    const localTracksByProcessIndexToHide = new Map<number, Set<TrackIndex>>();
    for (const [pid, filteredTracks] of searchFilteredLocalTracksByPid) {
      const globalTrack = globalTracks.find(
        (t) => t.type === 'process' && t.pid === pid
      );
      if (globalTrack?.type === 'process') {
        localTracksByProcessIndexToHide.set(
          globalTrack.processIndex,
          filteredTracks
        );
      }
    }
    hideProvidedTracks(
      searchFilteredGlobalTracks,
      localTracksByProcessIndexToHide
    );
  };

  _hideRightClickedTrack = (): void => {
    const { rightClickedTrack, hideLocalTrack, hideGlobalTrack } = this.props;
    if (rightClickedTrack === null) {
      return;
    }

    if (rightClickedTrack.type === 'global') {
      hideGlobalTrack(rightClickedTrack.trackIndex);
      return;
    }

    hideLocalTrack(
      rightClickedTrack.processIndex,
      rightClickedTrack.trackIndex
    );
  };

  _toggleGlobalTrackVisibility = (
    e: React.MouseEvent<HTMLElement>,
    data: { trackIndex: TrackIndex }
  ): void => {
    const { trackIndex } = data;
    const {
      hiddenGlobalTracks,
      hideGlobalTrack,
      showGlobalTrack,
      globalTracks,
    } = this.props;

    if (e.detail > 2) {
      // Ignore triple (and more) clicks
      return;
    }

    if (e.detail === 2) {
      // This is a double click.
      // Cancel the click timeout
      if (this._globalTrackClickTimeout !== null) {
        clearTimeout(this._globalTrackClickTimeout);
      }
      this._globalTrackClickTimeout = null;

      const track = globalTracks[trackIndex];
      if (track.type === 'process') {
        this._showLocalTracksInProcess(e, {
          trackIndex,
          processIndex: track.processIndex,
        });
        return;
      }
    }

    // This is a simple click. Let's defer a few milliseconds before carrying
    // the action, in case the user wants to do a double click.

    this._globalTrackClickTimeout = setTimeout(() => {
      if (hiddenGlobalTracks.has(trackIndex)) {
        showGlobalTrack(trackIndex);
      } else {
        hideGlobalTrack(trackIndex);
      }
    }, 150);
  };

  _toggleLocalTrackVisibility = (
    _: React.SyntheticEvent,
    data: {
      processIndex: number;
      trackIndex: TrackIndex;
      globalTrackIndex: TrackIndex;
    }
  ): void => {
    const { trackIndex, processIndex, globalTrackIndex } = data;
    const {
      hiddenLocalTracksByProcessIndex,
      hideLocalTrack,
      showLocalTrack,
      hiddenGlobalTracks,
      showGlobalTrack,
      localTrackOrderByProcessIndex,
    } = this.props;
    const hiddenLocalTracks = ensureExists(
      hiddenLocalTracksByProcessIndex.get(processIndex),
      'Expected to find hidden local tracks for the given processIndex'
    );

    if (hiddenGlobalTracks.has(globalTrackIndex)) {
      // When the parent global track is hidden, instead of simply
      // toggling, we'll just unhide the global track and this
      // particular local track. Other local tracks should be hidden.
      showGlobalTrack(globalTrackIndex);
      const localTrackOrder = ensureExists(
        localTrackOrderByProcessIndex.get(processIndex),
        'Expected to find local tracks for the given processIndex'
      );
      localTrackOrder.forEach((index) => {
        if (index === trackIndex) {
          showLocalTrack(processIndex, trackIndex);
        } else {
          hideLocalTrack(processIndex, index);
        }
      });
    } else {
      // When the global track is not hidden, we'll just go ahead and
      // toggle this local track.
      if (hiddenLocalTracks.has(trackIndex)) {
        showLocalTrack(processIndex, trackIndex);
      } else {
        hideLocalTrack(processIndex, trackIndex);
      }
    }
  };

  _getRightClickedTrackType = (): string => {
    const { rightClickedTrack, localTracksByPid, globalTracks } = this.props;

    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to get the track type with no right clicked track.'
      );
    }

    let track;
    switch (rightClickedTrack.type) {
      case 'local': {
        // Find the pid for this processIndex to look up localTracksByPid.
        const globalTrack = globalTracks.find(
          (t) =>
            t.type === 'process' &&
            t.processIndex === rightClickedTrack.processIndex
        );
        const pid = globalTrack?.type === 'process' ? globalTrack.pid : null;
        const localTracks = ensureExists(
          pid !== null ? localTracksByPid.get(pid) : undefined
        );
        track = localTracks[rightClickedTrack.trackIndex];
        break;
      }
      case 'global':
        track = globalTracks[rightClickedTrack.trackIndex];
        break;
      default:
        throw assertExhaustiveCheck(rightClickedTrack);
    }

    return track.type;
  };

  _hideTracksByType = (_: React.SyntheticEvent): void => {
    const {
      rightClickedTrack,
      globalTracks,
      localTracksByPid,
      hideProvidedTracks,
    } = this.props;

    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to hide tracks by type with no right clicked track.'
      );
    }
    const type = this._getRightClickedTrackType();

    const typeFilteredGlobalTracks = getTypeFilteredGlobalTracks(
      globalTracks,
      type
    );
    const typeFilteredLocalTracksByPid = getTypeFilteredLocalTracksByPid(
      localTracksByPid,
      type
    );

    if (
      typeFilteredGlobalTracks === null ||
      typeFilteredLocalTracksByPid === null
    ) {
      // This shouldn't happen!
      console.warn('Unexpected null type filtered tracks');
      return;
    }

    // Convert from pid-keyed to processIndex-keyed map.
    const localTracksByProcessIndexToHide = new Map<number, Set<TrackIndex>>();
    for (const [pid, filteredTracks] of typeFilteredLocalTracksByPid) {
      const globalTrack = globalTracks.find(
        (t) => t.type === 'process' && t.pid === pid
      );
      if (globalTrack?.type === 'process') {
        localTracksByProcessIndexToHide.set(
          globalTrack.processIndex,
          filteredTracks
        );
      }
    }
    hideProvidedTracks(
      typeFilteredGlobalTracks,
      localTracksByProcessIndexToHide
    );
  };

  _isolateProcess = () => {
    const { isolateProcess, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the process with no right clicked track.'
      );
    }
    if (rightClickedTrack.type === 'local') {
      throw new Error(
        'Attempting to isolate a process track with a local track is selected.'
      );
    }
    isolateProcess(rightClickedTrack.trackIndex);
  };

  _isolateScreenshot = () => {
    const { isolateScreenshot, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the screenshot with no right clicked track.'
      );
    }
    if (rightClickedTrack.type !== 'global') {
      throw new Error(
        'Attempting to isolate a screenshot track with a local track is selected.'
      );
    }
    isolateScreenshot(rightClickedTrack.trackIndex);
  };

  _isolateProcessMainThread = () => {
    const { isolateProcessMainThread, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the process main thread with no right clicked track.'
      );
    }

    if (rightClickedTrack.type === 'local') {
      throw new Error(
        'Attempting to isolate a process track with a local track is selected.'
      );
    }
    isolateProcessMainThread(rightClickedTrack.trackIndex);
  };

  _isolateLocalTrack = () => {
    const { isolateLocalTrack, rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      throw new Error(
        'Attempted to isolate the local track with no right clicked track.'
      );
    }

    if (rightClickedTrack.type === 'global') {
      throw new Error(
        'Attempting to isolate a local track with a global track is selected.'
      );
    }
    const { processIndex, trackIndex } = rightClickedTrack;
    isolateLocalTrack(processIndex, trackIndex);
  };

  _showLocalTracksInProcess = (
    _: React.SyntheticEvent,
    data: { trackIndex: TrackIndex; processIndex: number }
  ) => {
    const { trackIndex, processIndex } = data;
    const { showGlobalTrackIncludingLocalTracks } = this.props;
    showGlobalTrackIncludingLocalTracks(trackIndex, processIndex);
  };

  // Check if the global track has a local track that also matches the filter.
  // We should still show the global tracks that have them.
  _globalTrackHasSearchFilterMatchedChildren(
    track: GlobalTrack,
    searchFilteredLocalTracksByPid: Map<Pid, Set<TrackIndex>> | null
  ): boolean {
    if (track.type !== 'process' || searchFilteredLocalTracksByPid === null) {
      return false;
    }

    const searchFilteredLocalTracks = searchFilteredLocalTracksByPid.get(
      track.pid
    );
    if (!searchFilteredLocalTracks) {
      // This should not happen, but fail with a false if it does.
      return false;
    }
    return searchFilteredLocalTracks.size !== 0;
  }

  renderGlobalTrack(
    trackIndex: TrackIndex,
    searchFilteredGlobalTracks: Set<TrackIndex> | null,
    searchFilteredLocalTracksByPid: Map<Pid, Set<TrackIndex>> | null
  ) {
    const { hiddenGlobalTracks, globalTrackNames, globalTracks } = this.props;
    const isHidden = hiddenGlobalTracks.has(trackIndex);
    const track = globalTracks[trackIndex];
    const hasSearchFilterMatchedChildren =
      this._globalTrackHasSearchFilterMatchedChildren(
        track,
        searchFilteredLocalTracksByPid
      );
    const isHiddenBySearch =
      searchFilteredGlobalTracks && !searchFilteredGlobalTracks.has(trackIndex);

    if (isHiddenBySearch && !hasSearchFilterMatchedChildren) {
      // This means that both search filter doesn't match this global track, and
      // it doesn't have any local track that matches to the filter. In this
      // case, don't show it.
      return null;
    }

    // If a global track is selected by search, we should show all of its children.
    const skipSearchFilterInChildren =
      searchFilteredGlobalTracks !== null && !isHiddenBySearch;

    let title = `${globalTrackNames[trackIndex]}`;
    if (track.type === 'process') {
      title += ` (Process ID: ${track.pid})`;
    }

    const MenuItemAsAny = MenuItem as any; // https://github.com/firefox-devtools/react-contextmenu/issues/334
    return (
      <React.Fragment key={trackIndex}>
        <MenuItemAsAny
          preventClose={true}
          data={{ trackIndex }}
          onClick={this._toggleGlobalTrackVisibility}
          role="menuitemcheckbox"
          attributes={{
            className: classNames('timelineTrackContextMenuItem', {
              checkable: true,
              checked: !isHidden,
            }),
            title,
            'aria-checked': isHidden ? 'false' : 'true',
          }}
        >
          <span>{globalTrackNames[trackIndex]}</span>
          <span className="timelineTrackContextMenuSpacer" />
          {track.type === 'process' && (
            <span className="timelineTrackContextMenuPid">({track.pid})</span>
          )}
        </MenuItemAsAny>
        {track.type === 'process'
          ? this.renderLocalTracks(
              trackIndex,
              track.pid,
              track.processIndex,
              skipSearchFilterInChildren,
              searchFilteredLocalTracksByPid
            )
          : null}
      </React.Fragment>
    );
  }

  renderLocalTracks(
    globalTrackIndex: TrackIndex,
    pid: Pid,
    processIndex: number,
    skipSearchFilter: boolean,
    searchFilteredLocalTracksByPid: Map<Pid, Set<TrackIndex>> | null
  ) {
    const {
      hiddenLocalTracksByProcessIndex,
      localTrackOrderByProcessIndex,
      localTrackNamesByPid,
      hiddenGlobalTracks,
      localTracksByPid,
    } = this.props;

    const isGlobalTrackHidden = hiddenGlobalTracks.has(globalTrackIndex);
    const localTrackOrder = localTrackOrderByProcessIndex.get(processIndex);
    const hiddenLocalTracks = hiddenLocalTracksByProcessIndex.get(processIndex);
    const localTrackNames = localTrackNamesByPid.get(pid);
    const localTracks = localTracksByPid.get(pid);
    // If it's null, include everything without filtering.
    let searchFilteredLocalTracks = null;
    // skipSearchFilter will be true when the parent global track matches the filter.
    // It means that we can include all the local tracks without checking.
    if (searchFilteredLocalTracksByPid !== null && !skipSearchFilter) {
      // If there is a search filter AND we can't skip the search filter, then
      // get the filtered local tracks, so we can filter.
      searchFilteredLocalTracks = searchFilteredLocalTracksByPid.get(pid);
    }

    if (
      localTrackOrder === undefined ||
      hiddenLocalTracks === undefined ||
      localTrackNames === undefined ||
      localTracks === undefined
    ) {
      console.error(
        'Unable to find local track information for the given processIndex:',
        processIndex
      );
      return null;
    }

    const localTrackMenuItems = [];
    for (const trackIndex of localTrackOrder) {
      if (
        searchFilteredLocalTracks &&
        !searchFilteredLocalTracks.has(trackIndex)
      ) {
        // Search filter doesn't match this track, skip it.
        continue;
      }

      const isChecked =
        !hiddenLocalTracks.has(trackIndex) && !isGlobalTrackHidden;

      const MenuItemAsAny = MenuItem as any; // https://github.com/firefox-devtools/react-contextmenu/issues/334
      localTrackMenuItems.push(
        <MenuItemAsAny
          key={trackIndex}
          preventClose={true}
          data={{ processIndex, trackIndex, globalTrackIndex }}
          onClick={this._toggleLocalTrackVisibility}
          role="menuitemcheckbox"
          attributes={{
            className: classNames('checkable indented', {
              checked: isChecked,
            }),
            'aria-checked': isChecked ? 'true' : 'false',
          }}
        >
          {localTrackNames[trackIndex]}
        </MenuItemAsAny>
      );
    }

    return localTrackMenuItems;
  }

  getRightClickedTrackName(rightClickedTrack: TrackReference): string {
    const { globalTrackNames, localTrackNamesByPid, globalTracks } = this.props;

    if (rightClickedTrack.type === 'global') {
      return globalTrackNames[rightClickedTrack.trackIndex];
    }
    // Find the pid for this processIndex to look up localTrackNamesByPid.
    const globalTrack = globalTracks.find(
      (t) =>
        t.type === 'process' &&
        t.processIndex === rightClickedTrack.processIndex
    );
    const pid = globalTrack?.type === 'process' ? globalTrack.pid : null;
    const localTrackNames =
      pid !== null ? localTrackNamesByPid.get(pid) : undefined;
    if (localTrackNames === undefined) {
      console.error(
        'Expected to find a local track name for the given processIndex.'
      );
      return 'Unknown Track';
    }
    return localTrackNames[rightClickedTrack.trackIndex];
  }

  renderIsolateProcess() {
    const {
      rightClickedTrack,
      globalTracks,
      globalTrackOrder,
      hiddenGlobalTracks,
      hiddenLocalTracksByProcessIndex,
      localTracksByPid,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global' || globalTracks.length === 1) {
      // This is not a valid candidate for isolating.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'process') {
      // Only process tracks can be isolated.
      return null;
    }

    // Disable this option if there is only one left global track left.
    let isDisabled = hiddenGlobalTracks.size === globalTrackOrder.length - 1;

    if (!isDisabled && track.mainThreadIndex === null) {
      // Ensure there is a valid thread index in the local tracks to isolate, otherwise
      // disable this track.
      const localTracks = localTracksByPid.get(track.pid);
      const hiddenLocalTracks = hiddenLocalTracksByProcessIndex.get(
        track.processIndex
      );
      if (localTracks === undefined || hiddenLocalTracks === undefined) {
        console.error('Local track information for the given pid.');
        return null;
      }
      let hasVisibleLocalTrackWithMainThread = false;
      for (let trackIndex = 0; trackIndex < localTracks.length; trackIndex++) {
        const localTrack = localTracks[trackIndex];
        if (
          localTrack.type === 'thread' &&
          !hiddenLocalTracks.has(trackIndex)
        ) {
          hasVisibleLocalTrackWithMainThread = true;
          break;
        }
      }
      if (!hasVisibleLocalTrackWithMainThread) {
        // The process has no main thread, and there are no visible local tracks
        // with a thread index, do not offer to isolate in this case, but just disable
        // this button in case some threads become visible while the menu is open.
        isDisabled = true;
      }
    }

    return (
      <MenuItem onClick={this._isolateProcess} disabled={isDisabled}>
        <Localized id="TrackContextMenu--only-show-this-process">
          Only show this process
        </Localized>
      </MenuItem>
    );
  }

  renderIsolateProcessMainThread() {
    const {
      rightClickedTrack,
      globalTracks,
      hiddenGlobalTracks,
      hiddenLocalTracksByProcessIndex,
      localTrackOrderByProcessIndex,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global') {
      // This is not a valid candidate for isolating. Either there are not
      // enough threads, or the right clicked track didn't have an associated thread
      // index.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'process' || track.mainThreadIndex === null) {
      // Only process tracks with a main thread can be isolated.
      return null;
    }

    // Look up the local track information.
    const hiddenLocalTracks = hiddenLocalTracksByProcessIndex.get(
      track.processIndex
    );
    const localTrackOrder = localTrackOrderByProcessIndex.get(
      track.processIndex
    );
    if (hiddenLocalTracks === undefined || localTrackOrder === undefined) {
      console.error(
        'Expected to find local track information for the given processIndex.'
      );
      return null;
    }

    const isDisabled =
      // Does it have no visible local tracks?
      hiddenLocalTracks.size === localTrackOrder.length &&
      // Is there only one visible global track?
      globalTracks.length - hiddenGlobalTracks.size === 1;

    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    return (
      <MenuItem onClick={this._isolateProcessMainThread} disabled={isDisabled}>
        <Localized
          id="TrackContextMenu--only-show-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Only show {`“${rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  renderIsolateLocalTrack() {
    const {
      rightClickedTrack,
      globalTracks,
      hiddenGlobalTracks,
      hiddenLocalTracksByProcessIndex,
      localTrackOrderByProcessIndex,
    } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type === 'global') {
      return null;
    }

    // Select the local track info.
    const hiddenLocalTracks = hiddenLocalTracksByProcessIndex.get(
      rightClickedTrack.processIndex
    );
    const localTrackOrder = localTrackOrderByProcessIndex.get(
      rightClickedTrack.processIndex
    );
    if (hiddenLocalTracks === undefined || localTrackOrder === undefined) {
      console.error(
        'Expected to find local track information for the given processIndex.'
      );
      return null;
    }

    const isDisabled =
      // Is there only one global track visible?
      globalTracks.length - hiddenGlobalTracks.size === 1 &&
      // Is there only one local track left?
      localTrackOrder.length - hiddenLocalTracks.size === 1;

    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    return (
      <MenuItem onClick={this._isolateLocalTrack} disabled={isDisabled}>
        <Localized
          id="TrackContextMenu--only-show-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Only show {`“rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  renderShowLocalTracksInThisProcess() {
    const {
      rightClickedTrack,
      globalTracks,
      localTracksByPid,
      hiddenLocalTracksByProcessIndex,
    } = this.props;
    if (rightClickedTrack === null) {
      return null;
    }
    const { trackIndex } = rightClickedTrack;

    let pid: Pid | null = null;
    let processIndex: number | null = null;
    if (rightClickedTrack.type === 'global') {
      const globalTrack = globalTracks[trackIndex];
      if (!globalTrack || globalTrack.type !== 'process') {
        return null;
      }
      pid = globalTrack.pid;
      processIndex = globalTrack.processIndex;
    } else {
      // Find the pid for this processIndex.
      const globalTrack = globalTracks.find(
        (t) =>
          t.type === 'process' &&
          t.processIndex === rightClickedTrack.processIndex
      );
      if (!globalTrack || globalTrack.type !== 'process') {
        return null;
      }
      pid = globalTrack.pid;
      processIndex = rightClickedTrack.processIndex;
    }

    const localTracks = localTracksByPid.get(pid);
    if (!localTracks || !localTracks.length) {
      return null;
    }

    const hiddenLocalTracks = hiddenLocalTracksByProcessIndex.get(processIndex);
    const isDisabled = !hiddenLocalTracks || hiddenLocalTracks.size === 0;

    return (
      <MenuItem
        onClick={this._showLocalTracksInProcess}
        disabled={isDisabled}
        data={{ trackIndex, processIndex }}
      >
        <Localized id="TrackContextMenu--show-local-tracks-in-process">
          Show all tracks in this process
        </Localized>
      </MenuItem>
    );
  }

  getVisibleScreenshotTracks(): GlobalTrack[] {
    const { globalTracks, hiddenGlobalTracks } = this.props;
    const visibleScreenshotTracks = globalTracks.filter(
      (globalTrack, trackIndex) =>
        globalTrack.type === 'screenshots' &&
        !hiddenGlobalTracks.has(trackIndex)
    );
    return visibleScreenshotTracks;
  }

  renderIsolateScreenshot() {
    const { rightClickedTrack, globalTracks } = this.props;

    if (rightClickedTrack === null) {
      return null;
    }

    if (rightClickedTrack.type !== 'global') {
      // This is not a valid candidate for isolating.
      return null;
    }

    const track = globalTracks[rightClickedTrack.trackIndex];
    if (track.type !== 'screenshots') {
      // Only process screenshot tracks
      return null;
    }

    // We check that it's less or equal to 1 (instead of just equal to 1)
    // because we want to also leave the item disabled when we hide the last
    // screenshot track while the menu is open.
    const isDisabled = this.getVisibleScreenshotTracks().length <= 1;
    return (
      <MenuItem onClick={this._isolateScreenshot} disabled={isDisabled}>
        <Localized id="TrackContextMenu--hide-other-screenshots-tracks">
          Hide other Screenshots tracks
        </Localized>
      </MenuItem>
    );
  }

  renderHideTrack() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      return null;
    }
    const trackIndex = rightClickedTrack.trackIndex;
    const rightClickedTrackName =
      this.getRightClickedTrackName(rightClickedTrack);

    return (
      <MenuItem
        key={trackIndex}
        preventClose={false}
        onClick={this._hideRightClickedTrack}
      >
        <Localized
          id="TrackContextMenu--hide-track"
          vars={{ trackName: rightClickedTrackName }}
        >
          <>Hide {`“${rightClickedTrackName}”`}</>
        </Localized>
      </MenuItem>
    );
  }

  renderHideTrackByType() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack === null) {
      return null;
    }

    // When adding more allowed types, we need to take care that we can't enter
    // one of the following cases:
    // 1. Hiding a global track that still has visible local tracks
    // 2. No more visible tracks
    // 3. One global track without any data is displayed
    // (all its local track are hidden + it doesn't have any data itself)

    const ALLOWED_TYPES = [
      'screenshots',
      'memory',
      'network',
      'ipc',
      'event-delay',
    ];

    const type = this._getRightClickedTrackType();

    if (ALLOWED_TYPES.includes(type)) {
      return (
        <MenuItem preventClose={false} onClick={this._hideTracksByType}>
          <Localized
            id="TrackContextMenu--hide-all-tracks-by-selected-track-type"
            vars={{ type }}
          >
            <>Hide all tracks of type “{type}”</>
          </Localized>
        </MenuItem>
      );
    }
    return null;
  }

  renderShowAllTracks() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack !== null) {
      return null;
    }
    const hiddenLocalTracksCount = [
      ...this.props.hiddenLocalTracksByProcessIndex.values(),
    ].reduce((total, set) => total + set.size, 0);
    const isDisabled =
      hiddenLocalTracksCount + this.props.hiddenGlobalTracks.size === 0;

    return (
      <MenuItem onClick={this._showAllTracks} disabled={isDisabled}>
        <Localized id="TrackContextMenu--show-all-tracks">
          Show all tracks
        </Localized>
      </MenuItem>
    );
  }

  renderShowProvidedTracks() {
    const { rightClickedTrack } = this.props;
    if (rightClickedTrack !== null) {
      return null;
    }

    return (
      <MenuItem onClick={this._showMatchingTracks}>
        <Localized id="TrackContextMenu--show-all-matching-tracks">
          Show all matching tracks
        </Localized>
      </MenuItem>
    );
  }

  renderHideMatchingTracks(
    searchFilteredGlobalTracks: Set<TrackIndex>,
    searchFilteredLocalTracksByPid: Map<Pid, Set<TrackIndex>>
  ) {
    const {
      rightClickedTrack,
      hiddenGlobalTracks,
      globalTracks,
      hiddenLocalTracksByProcessIndex,
      localTracksByPid,
    } = this.props;
    if (rightClickedTrack !== null) {
      // This option should only be visible in the top context menu and not when
      // user right clicks on a track.
      return null;
    }

    // We need to do a few checks here to determine if this menu item should be
    // enabled or not. Two things we need to check:
    // 1. Are there any global tracks left to show after hiding the matched tracks?
    // 2. Are there any global (2.1) or local tracks (2.2) to hide for this
    // search filter?
    // Also, all these checks (1, 2.1, 2.2) are extracted into arrow functions,
    // so we don't have to do all these checks if they are not needed.

    // 1. First we need to check if there are going to be visible tracks left
    // after hiding the matching ones.
    // Check `subtractSets(visible tracks, search filtered tracks)`. Since we
    // don't have the computed visible tracks, let's check the same thing with
    // the hidden tracks.

    // New global tracks counts after this menu item is clicked.
    const hasVisibleGlobalTracksLeftAfterHiding = () => {
      // For the global tracks with no main threads, we should check if all of
      // their local tracks are going to be hidden. If so, we should make sure
      // that we account them while calculating the hidden global track count.
      let newHiddenGlobalTracksWithoutMainThread = 0;
      for (const [
        pid,
        searchFilteredLocalTracks,
      ] of searchFilteredLocalTracksByPid) {
        const globalTrackIndex = ensureExists(
          globalTracks.findIndex(
            (track) => track.type === 'process' && track.pid === pid
          )
        );
        if (hiddenGlobalTracks.has(globalTrackIndex)) {
          // Do not check the already hidden global tracks since they are already hidden.
          continue;
        }

        const globalTrack = globalTracks[globalTrackIndex];
        const mainThreadIndex =
          'mainThreadIndex' in globalTrack ? globalTrack.mainThreadIndex : null;
        if (mainThreadIndex !== null) {
          // We only need to check the global tracks without main threads.
          continue;
        }

        // This is a process global track without main thread.
        // We should check if all of its local tracks are going to be visible or not.
        const localTracks = ensureExists(localTracksByPid.get(pid));
        const processGlobalTrack = globalTracks[globalTrackIndex];
        const processIdx =
          processGlobalTrack.type === 'process'
            ? processGlobalTrack.processIndex
            : -1;
        const hiddenLocalTracks = ensureExists(
          hiddenLocalTracksByProcessIndex.get(processIdx)
        );
        const newHiddenLocalTrackCount =
          hiddenLocalTracks.size +
          searchFilteredLocalTracks.size -
          intersectSets(hiddenLocalTracks, searchFilteredLocalTracks).size;

        if (newHiddenLocalTrackCount === localTracks.length) {
          // All of this global track's local tracks are going to be hidden.
          // This global track is going to be hidden as well, so add this to the
          // hidden global tracks count.
          newHiddenGlobalTracksWithoutMainThread += 1;
        }
      }

      const newHiddenGlobalTrackCount =
        hiddenGlobalTracks.size +
        searchFilteredGlobalTracks.size -
        intersectSets(hiddenGlobalTracks, searchFilteredGlobalTracks).size +
        newHiddenGlobalTracksWithoutMainThread;
      return newHiddenGlobalTrackCount < globalTracks.length;
    };

    // 2.1. Check if there are any global tracks to hide.
    const hasGlobalTrackToHide = () =>
      [...searchFilteredGlobalTracks].some(
        (trackIndex) => !hiddenGlobalTracks.has(trackIndex)
      );

    // 2.2. Check if there are any local tracks to hide. It's a bit more
    // complicated than checking the global tracks because of the nested Map/Sets.

    const hasLocalTrackToHide = () => {
      // Create a hidden global track pids set for faster checks.
      const hiddenGlobalTrackPids = new Set<Pid>();
      for (const trackIndex of hiddenGlobalTracks) {
        const globalTrack = globalTracks[trackIndex];
        if (globalTrack.type === 'process') {
          hiddenGlobalTrackPids.add(globalTrack.pid);
        }
      }

      // Build a pid-to-processIndex mapping for looking up hiddenLocalTracks.
      const pidToProcessIndex = new Map<Pid, number>();
      for (const globalTrack of globalTracks) {
        if (globalTrack.type === 'process') {
          pidToProcessIndex.set(globalTrack.pid, globalTrack.processIndex);
        }
      }

      let hasLocalTrackToHide = false;
      for (const [
        pid,
        searchFilteredLocalTracks,
      ] of searchFilteredLocalTracksByPid) {
        if (hiddenGlobalTrackPids.has(pid)) {
          // The global track is already hidden. Do not check the local tracks of it.
          continue;
        }

        const pIdx = ensureExists(pidToProcessIndex.get(pid));
        const hiddenLocalTracks = ensureExists(
          hiddenLocalTracksByProcessIndex.get(pIdx)
        );
        hasLocalTrackToHide = [...searchFilteredLocalTracks].some(
          (trackIndex) => !hiddenLocalTracks.has(trackIndex)
        );
        if (hasLocalTrackToHide) {
          // There is at least one local track to hide. Skip the other global track checks.
          break;
        }
      }

      return hasLocalTrackToHide;
    };

    const isDisabled =
      !hasVisibleGlobalTracksLeftAfterHiding() ||
      (!hasGlobalTrackToHide() && !hasLocalTrackToHide());

    return (
      <MenuItem onClick={this._hideMatchedTracks} disabled={isDisabled}>
        <Localized id="TrackContextMenu--hide-all-matching-tracks">
          Hide all matching tracks
        </Localized>
      </MenuItem>
    );
  }

  renderTrackSearchField() {
    const { rightClickedTrack } = this.props;
    const { searchFilter } = this.state;
    if (rightClickedTrack !== null) {
      // This option should only be visible in the top context menu and not when
      // user right clicks.
      return null;
    }

    return (
      <React.Fragment>
        <TrackSearchField
          className="trackContextMenuSearchField"
          currentSearchString={searchFilter}
          onSearch={this._onSearch}
          ref={this._trackSearchFieldElem}
        />
        <div className="react-contextmenu-separator" />
      </React.Fragment>
    );
  }

  _onSearch = (value: string) => {
    this.setState({ searchFilter: value });
  };

  _onShow = () => {
    const trackFieldElement = this._trackSearchFieldElem.current;
    if (
      // We need to focus the track search filter. But we can't use autoFocus
      // property because this context menu is already rendered and hidden during
      // the load of the web page.
      trackFieldElement
    ) {
      // Allow time for React contect menu to show itself first.
      setTimeout(() => {
        trackFieldElement.focus();
      });
    }
  };

  _onHide = () => {
    this.setState({ searchFilter: '' });
  };

  override render() {
    const {
      threads,
      processes,
      globalTrackOrder,
      globalTracks,
      globalTrackNames,
      localTracksByPid,
      localTrackNamesByPid,
      rightClickedTrack,
    } = this.props;
    const { searchFilter } = this.state;
    const isolateProcessMainThread = this.renderIsolateProcessMainThread();
    const isolateProcess = this.renderIsolateProcess();
    const isolateLocalTrack = this.renderIsolateLocalTrack();
    const isolateScreenshot = this.renderIsolateScreenshot();
    const showLocalTracksInProcess = this.renderShowLocalTracksInThisProcess();
    const hideTrack = this.renderHideTrack();
    const hideTrackByType = this.renderHideTrackByType();
    const separator =
      isolateProcessMainThread ||
      isolateProcess ||
      isolateLocalTrack ||
      isolateScreenshot ||
      showLocalTracksInProcess ||
      hideTrack ||
      hideTrackByType ? (
        <div className="react-contextmenu-separator" />
      ) : null;
    const searchFilteredGlobalTracks = getSearchFilteredGlobalTracks(
      globalTracks,
      globalTrackNames,
      threads,
      processes,
      searchFilter
    );
    const searchFilteredLocalTracksByPid = getSearchFilteredLocalTracksByPid(
      localTracksByPid,
      localTrackNamesByPid,
      threads,
      processes,
      searchFilter
    );

    const filteredGlobalTracks = globalTrackOrder.map((globalTrackIndex) => {
      const globalTrack = globalTracks[globalTrackIndex];
      if (rightClickedTrack === null) {
        return this.renderGlobalTrack(
          globalTrackIndex,
          searchFilteredGlobalTracks,
          searchFilteredLocalTracksByPid
        );
      } else if (
        rightClickedTrack.type === 'global' &&
        rightClickedTrack.trackIndex === globalTrackIndex
      ) {
        return this.renderGlobalTrack(
          globalTrackIndex,
          searchFilteredGlobalTracks,
          searchFilteredLocalTracksByPid
        );
      } else if (
        rightClickedTrack.type === 'local' &&
        globalTrack.type === 'process'
      ) {
        if (rightClickedTrack.processIndex === globalTrack.processIndex) {
          return this.renderGlobalTrack(
            globalTrackIndex,
            searchFilteredGlobalTracks,
            searchFilteredLocalTracksByPid
          );
        }
      }
      return null;
    });

    // If every global track is null, it means that they are all filtered out.
    // In that case, we should show a warning explaining this.
    const isTrackListEmpty = filteredGlobalTracks.every(
      (track) => track === null
    );

    return (
      <ContextMenuNoHidingOnEnter
        id="TimelineTrackContextMenu"
        className="timelineTrackContextMenu"
        onShow={this._onShow}
        onHide={this._onHide}
      >
        {
          // The menu items header items to isolate tracks may or may not be
          // visible depending on the current state.
        }
        {this.renderTrackSearchField()}
        {searchFilter
          ? this.renderShowProvidedTracks()
          : this.renderShowAllTracks()}
        {searchFilter &&
        searchFilteredGlobalTracks &&
        searchFilteredLocalTracksByPid
          ? this.renderHideMatchingTracks(
              searchFilteredGlobalTracks,
              searchFilteredLocalTracksByPid
            )
          : null}
        {rightClickedTrack === null ? (
          <div className="react-contextmenu-separator" />
        ) : null}
        {isolateProcessMainThread}
        {isolateProcess}
        {isolateLocalTrack}
        {isolateScreenshot}
        {hideTrack}
        {hideTrackByType}
        {showLocalTracksInProcess ? (
          <div className="react-contextmenu-separator" />
        ) : null}
        {showLocalTracksInProcess}
        {separator}
        {isTrackListEmpty ? (
          <Localized
            id="TrackContextMenu--no-results-found"
            vars={{ searchFilter: searchFilter }}
            elems={{
              span: <span className="trackContextMenuSearchFilter" />,
            }}
          >
            <MenuItem disabled={true}>
              No results found for “
              <span className="trackContextMenuSearchFilter">
                {searchFilter}
              </span>
              ”
            </MenuItem>
          </Localized>
        ) : (
          filteredGlobalTracks
        )}
      </ContextMenuNoHidingOnEnter>
    );
  }
}

export const TimelineTrackContextMenu = explicitConnect<
  {},
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state: State) => ({
    threads: getThreads(state),
    processes: getProcesses(state),
    globalTrackOrder: getGlobalTrackOrder(state),
    hiddenGlobalTracks: getHiddenGlobalTracks(state),
    rightClickedTrack: getRightClickedTrack(state),
    globalTracks: getGlobalTracks(state),
    hiddenLocalTracksByProcessIndex: getHiddenLocalTracksByProcessIndex(state),
    localTrackOrderByProcessIndex: getLocalTrackOrderByProcessIndex(state),
    rightClickedThreadIndex: getRightClickedThreadIndex(state),
    globalTrackNames: getGlobalTrackNames(state),
    localTracksByPid: getLocalTracksByPid(state),
    localTrackNamesByPid: getLocalTrackNamesByPid(state),
  }),
  mapDispatchToProps: {
    hideGlobalTrack,
    showAllTracks,
    showGlobalTrack,
    showGlobalTrackIncludingLocalTracks,
    isolateProcess,
    isolateLocalTrack,
    isolateProcessMainThread,
    isolateScreenshot,
    hideLocalTrack,
    showLocalTrack,
    showProvidedTracks,
    hideProvidedTracks,
  },
  component: TimelineTrackContextMenuImpl,
});
