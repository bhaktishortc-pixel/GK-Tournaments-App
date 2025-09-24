const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");

admin.initializeApp();

// Apni Razorpay Keys ko yahan સીधे na likhein.
// Inhein Cloud Shell mein neeche diye gaye command se set karein:
// firebase functions:config:set razorpay.key_id="YOUR_KEY_ID"
// firebase functions:config:set razorpay.key_secret="YOUR_KEY_SECRET"
const razorpayKeyId = functions.config().razorpay.key_id;
const razorpayKeySecret = functions.config().razorpay.key_secret;

const razorpayInstance = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret,
});

/**
 * Order banane ke liye Cloud Function
 */
exports.createOrder = functions.region("asia-south1").https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Please login to create an order.");
    }

    const options = {
        amount: data.amount, // amount in paise (e.g., 1000 for ₹10)
        currency: "INR",
        receipt: `receipt_${new Date().getTime()}`,
    };

    try {
        const order = await razorpayInstance.orders.create(options);
        // Frontend ke liye Key ID bhi response mein bhej dein
        return { ...order, razorpayKeyId };
    } catch (error) {
        console.error("Razorpay order creation failed:", error);
        throw new functions.https.HttpsError("internal", "Could not create Razorpay order.");
    }
});

/**
 * Payment ko verify karke Wallet update karne ke liye Cloud Function
 */
exports.verifyPaymentAndUpdateWallet = functions.region("asia-south1").https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Please login to verify payment.");
    }

    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        amount,
    } = data;
    const userId = context.auth.uid;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const crypto = require("crypto");
    const expectedSignature = crypto
        .createHmac("sha256", razorpayKeySecret)
        .update(body.toString())
        .digest("hex");

    if (expectedSignature === razorpay_signature) {
        // Payment sahi hai
        const userWalletRef = admin.firestore().collection("users").doc(userId);
        
        // Transaction ko payments collection mein save karein
        await admin.firestore().collection("payments").add({
            userId: userId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            amount: amount,
            status: "success",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        // User ke wallet mein balance badhayein
        await userWalletRef.update({
            walletBalance: admin.firestore.FieldValue.increment(amount / 100) // amount ko rupayon mein convert karein
        });
        
        return { status: "success", message: "Wallet updated successfully!" };
    } else {
        // Payment verification fail ho gaya
        return { status: "failed", message: "Payment verification failed." };
    }
});