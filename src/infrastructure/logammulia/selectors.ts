/**
 * All Playwright selectors for Logam Mulia checkout flow.
 */
export const SELECTORS = {
  login: {
    emailInput: 'input[name="email"]',
    passwordInput: 'input[name="password"], #id_password',
    submitButton: 'input#login-btn',
    loginForm: '#login_form',
    loggedInIndicator: 'li.user-desktop, a[href*="/logout"]',
    recaptchaAnchor: '#recaptcha-anchor',
  },

  purchase: {
    // Stock container
    stockContainer: '.cart-table .ct-body',
    stockItem: '.ctr',
    
    // Weight label inside each row
    weightLabel: '.ngc-text',
    
    // Quantity input
    qtyInput: 'input.qty[type="number"]',
    
    // Sold out indicator
    soldOutIndicator: 'span.no-stock',
    
    // Add to cart / checkout button on purchase page
    checkoutButton: '#btn-checkout, button[type="submit"]',
  },

  cart: {
    // Cart page checkout button
    checkoutButton: '.btn-checkout, #btn-checkout, a[href*="/checkout"]',
    
    // Cart items
    cartItem: '.cart-item, .ctr',
    
    // Remove item button
    removeButton: '.btn-remove, .remove-item',
  },

  checkout: {
    // Shipping options
    shippingContainer: '.shipping-options, #shipping-method',
    paxelOption: 'input[value*="paxel"], label:has-text("Paxel")',
    
    // Payment options
    paymentContainer: '.payment-options, #payment-method',
    virtualAccountOption: 'input[value*="va"], input[value*="virtual"]',
    mandiriOption: 'input[value*="mandiri"], label:has-text("Mandiri")',
    
    // Agreement checkbox
    agreementCheckbox: 'input[type="checkbox"][name*="agree"], #agree-checkbox',
    
    // Pay now button
    payButton: '#btn-pay, .btn-pay, button:has-text("Bayar")',
  },

  confirmation: {
    // VA number display
    vaNumber: '.va-number, .payment-code, [data-va-number]',
    
    // Order details
    orderNumber: '.order-number, .order-id',
    totalAmount: '.total-amount, .grand-total',
  },
};

export const URLS = {
  login: 'https://www.logammulia.com/id/login',
  purchase: 'https://www.logammulia.com/id/purchase/gold',
  cart: 'https://www.logammulia.com/id/my-cart',
  checkout: 'https://www.logammulia.com/id/checkout',
  confirmation: 'https://www.logammulia.com/checkout',
};
