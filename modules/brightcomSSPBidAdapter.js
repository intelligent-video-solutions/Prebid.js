import {
  getBidIdParameter,
  isArray,
  getWindowTop,
  getUniqueIdentifierStr,
  deepSetValue,
  logError,
  logWarn,
  createTrackPixelHtml,
  getWindowSelf,
  isFn,
  isPlainObject,
} from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {BANNER} from '../src/mediaTypes.js';
import {config} from '../src/config.js';
import {ajax} from '../src/ajax.js';

const BIDDER_CODE = 'bcmssp';
const URL = 'https://rt.marphezis.com/hb';
const TRACK_EVENT_URL = 'https://rt.marphezis.com/prebid'

export const spec = {
  code: BIDDER_CODE,
  gvlid: 883,
  supportedMediaTypes: [BANNER],
  isBidRequestValid,
  buildRequests,
  interpretResponse,
  onBidderError,
  onTimeout,
  onBidWon,
  getUserSyncs,
};

function buildRequests(bidReqs, bidderRequest) {
  try {
    const impressions = bidReqs.map(bid => {
      let bidSizes = bid?.mediaTypes?.banner?.sizes || bid.sizes;
      bidSizes = ((isArray(bidSizes) && isArray(bidSizes[0])) ? bidSizes : [bidSizes]);
      bidSizes = bidSizes.filter(size => isArray(size));
      const processedSizes = bidSizes.map(size => ({w: parseInt(size[0], 10), h: parseInt(size[1], 10)}));

      const element = document.getElementById(bid.adUnitCode);
      const minSize = _getMinSize(processedSizes);
      const viewabilityAmount = _isViewabilityMeasurable(element) ? _getViewability(element, getWindowTop(), minSize) : 'na';
      const viewabilityAmountRounded = isNaN(viewabilityAmount) ? viewabilityAmount : Math.round(viewabilityAmount);

      const imp = {
        id: bid.bidId,
        banner: {
          format: processedSizes,
          ext: {
            viewability: viewabilityAmountRounded
          }
        },
        tagid: String(bid.adUnitCode)
      };

      const bidFloor = _getBidFloor(bid);

      if (bidFloor) {
        imp.bidfloor = bidFloor;
      }

      return imp;
    })

    const referrer = bidderRequest?.refererInfo?.page || '';
    const publisherId = getBidIdParameter('publisherId', bidReqs[0].params);

    const payload = {
      id: getUniqueIdentifierStr(),
      imp: impressions,
      site: {
        domain: bidderRequest?.refererInfo?.domain || '',
        page: referrer,
        publisher: {
          id: publisherId
        }
      },
      device: {
        devicetype: _getDeviceType(),
        w: screen.width,
        h: screen.height
      },
      tmax: config.getConfig('bidderTimeout')
    };

    if (bidderRequest?.gdprConsent) {
      deepSetValue(payload, 'regs.ext.gdpr', +bidderRequest.gdprConsent.gdprApplies);
      deepSetValue(payload, 'user.ext.consent', bidderRequest.gdprConsent.consentString);
    }

    if (bidderRequest?.uspConsent) {
      deepSetValue(payload, 'regs.ext.us_privacy', bidderRequest.uspConsent);
    }

    if (config.getConfig('coppa') === true) {
      deepSetValue(payload, 'regs.coppa', 1);
    }

    if (bidReqs?.[0]?.schain) {
      deepSetValue(payload, 'source.ext.schain', bidReqs[0].schain)
    }

    if (bidReqs?.[0]?.userIdAsEids) {
      deepSetValue(payload, 'user.ext.eids', bidReqs[0].userIdAsEids || [])
    }

    if (bidReqs?.[0].userId) {
      deepSetValue(payload, 'user.ext.ids', bidReqs[0].userId || [])
    }

    return {
      method: 'POST',
      url: URL,
      data: JSON.stringify(payload),
      options: {contentType: 'text/plain', withCredentials: false}
    };
  } catch (e) {
    logError(e, {bidReqs, bidderRequest});
  }
}

function isBidRequestValid(bid) {
  if (bid.bidder !== BIDDER_CODE || !bid.params || !bid.params.publisherId) {
    return false;
  }

  return true;
}

function interpretResponse(serverResponse) {
  let response = [];
  if (!serverResponse.body || typeof serverResponse.body != 'object') {
    logWarn('Brightcom server returned empty/non-json response: ' + JSON.stringify(serverResponse.body));
    return response;
  }

  const {body: {id, seatbid}} = serverResponse;

  try {
    if (id && seatbid && seatbid.length > 0 && seatbid[0].bid && seatbid[0].bid.length > 0) {
      response = seatbid[0].bid.map(bid => {
        return {
          requestId: bid.impid,
          cpm: parseFloat(bid.price),
          width: parseInt(bid.w),
          height: parseInt(bid.h),
          creativeId: bid.crid || bid.id,
          currency: 'USD',
          netRevenue: true,
          mediaType: BANNER,
          ad: _getAdMarkup(bid),
          ttl: 60,
          meta: {
            advertiserDomains: bid?.adomain || []
          }
        };
      });
    }
  } catch (e) {
    logError(e, {id, seatbid});
  }

  return response;
}

// Don't do user sync for now
function getUserSyncs(syncOptions, responses, gdprConsent) {
  return [];
}

function onTimeout(timeoutData) {
  if (timeoutData === null) {
    return;
  }

  _trackEvent('timeout', timeoutData);
}

function onBidderError(errorData) {
  if (errorData === null || !errorData.bidderRequest) {
    return;
  }

  _trackEvent('error', errorData.bidderRequest)
}

function onBidWon(bid) {
  if (bid === null) {
    return;
  }

  _trackEvent('bidwon', bid)
}

function _trackEvent(endpoint, data) {
  ajax(`${TRACK_EVENT_URL}/${endpoint}`, null, JSON.stringify(data), {
    method: 'POST',
    withCredentials: false
  });
}

function _isMobile() {
  return (/(ios|ipod|ipad|iphone|android)/i).test(navigator.userAgent);
}

function _isConnectedTV() {
  return (/(smart[-]?tv|hbbtv|appletv|googletv|hdmi|netcast\.tv|viera|nettv|roku|\bdtv\b|sonydtv|inettvbrowser|\btv\b)/i).test(navigator.userAgent);
}

function _getDeviceType() {
  return _isMobile() ? 1 : _isConnectedTV() ? 3 : 2;
}

function _getAdMarkup(bid) {
  let adm = bid.adm;
  if ('nurl' in bid) {
    adm += createTrackPixelHtml(bid.nurl);
  }
  return adm;
}

function _isViewabilityMeasurable(element) {
  return !_isIframe() && element !== null;
}

function _getViewability(element, topWin, {w, h} = {}) {
  return getWindowTop().document.visibilityState === 'visible' ? _getPercentInView(element, topWin, {w, h}) : 0;
}

function _isIframe() {
  try {
    return getWindowSelf() !== getWindowTop();
  } catch (e) {
    return true;
  }
}

function _getMinSize(sizes) {
  return sizes.reduce((min, size) => size.h * size.w < min.h * min.w ? size : min);
}

function _getBoundingBox(element, {w, h} = {}) {
  let {width, height, left, top, right, bottom} = element.getBoundingClientRect();

  if ((width === 0 || height === 0) && w && h) {
    width = w;
    height = h;
    right = left + w;
    bottom = top + h;
  }

  return {width, height, left, top, right, bottom};
}

function _getIntersectionOfRects(rects) {
  const bbox = {
    left: rects[0].left, right: rects[0].right, top: rects[0].top, bottom: rects[0].bottom
  };

  for (let i = 1; i < rects.length; ++i) {
    bbox.left = Math.max(bbox.left, rects[i].left);
    bbox.right = Math.min(bbox.right, rects[i].right);

    if (bbox.left >= bbox.right) {
      return null;
    }

    bbox.top = Math.max(bbox.top, rects[i].top);
    bbox.bottom = Math.min(bbox.bottom, rects[i].bottom);

    if (bbox.top >= bbox.bottom) {
      return null;
    }
  }

  bbox.width = bbox.right - bbox.left;
  bbox.height = bbox.bottom - bbox.top;

  return bbox;
}

function _getPercentInView(element, topWin, {w, h} = {}) {
  const elementBoundingBox = _getBoundingBox(element, {w, h});

  // Obtain the intersection of the element and the viewport
  const elementInViewBoundingBox = _getIntersectionOfRects([{
    left: 0, top: 0, right: topWin.innerWidth, bottom: topWin.innerHeight
  }, elementBoundingBox]);

  let elementInViewArea, elementTotalArea;

  if (elementInViewBoundingBox !== null) {
    // Some or all of the element is in view
    elementInViewArea = elementInViewBoundingBox.width * elementInViewBoundingBox.height;
    elementTotalArea = elementBoundingBox.width * elementBoundingBox.height;

    return ((elementInViewArea / elementTotalArea) * 100);
  }

  // No overlap between element and the viewport; therefore, the element
  // lies completely out of view
  return 0;
}

function _getBidFloor(bid) {
  if (!isFn(bid.getFloor)) {
    return bid.params.bidFloor ? bid.params.bidFloor : null;
  }

  let floor = bid.getFloor({
    currency: 'USD', mediaType: '*', size: '*'
  });
  if (isPlainObject(floor) && !isNaN(floor.floor) && floor.currency === 'USD') {
    return floor.floor;
  }
  return null;
}

registerBidder(spec);
